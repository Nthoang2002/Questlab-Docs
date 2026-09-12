# Domain: Task Import (Portal / SFTP / External Storage)

> Requirement gốc trong repo: `docs/PORTAL-TASK-MANAGEMENT-CREATE-TASK-REQUIREMENT.md`,
> `docs/REQUIREMENT-EXTERNAL-STORAGE-SCHEDULED-MANIFEST-TASK-IMPORT.md`.
> Đây là domain **lớn nhất về số file** trong project.

---

## 1. Purpose

Đưa dữ liệu thô **vào** hệ thống để tạo task. Ba nguồn:

| `ImportSource` | Ai kích hoạt | Trạng thái |
|---|---|---|
| `PORTAL_UPLOAD` / `PORTAL_BATCH_UPLOAD` | Admin upload file qua Portal | luôn bật |
| `SFTP` | Job quét thư mục SFTP | `task-import.sftp.enabled` (default **false**) |
| `EXTERNAL_STORAGE_SCHEDULED` | Lịch quét S3/MinIO/SFTP theo manifest | `task-import.external-storage.enabled` (default **true**) |
| `SYSTEM_RETRY` | Hệ thống retry job cũ | |

Đích đến luôn giống nhau: **tạo task trên Label Studio**, rồi **mirror về `tasks` local**.

---

## 2. Entry points

### Portal upload — `TaskImportController`

| Method | Endpoint | Mục đích |
|---|---|---|
| GET | `/projects/{projectUuid}/task-imports/spec` | §11.1 — cấu hình import cho project (format cho phép, data key bắt buộc từ `label_config`) |
| POST | `/projects/{projectUuid}/task-imports/preview` | §11.2 — parse + validate 1 file, **chưa ghi gì** |
| POST | `/projects/{projectUuid}/task-imports/preview/batch` | preview nhiều file |
| POST | `/projects/{projectUuid}/task-imports` | tạo job import 1 file |
| POST | `/projects/{projectUuid}/task-imports/batch` | tạo job import nhiều file |

### Job tracking — `TaskImportJobController` (`/task-import-jobs`)

| Method | Endpoint |
|---|---|
| GET | `/task-import-jobs/{jobUuid}` — trạng thái |
| GET | `/task-import-jobs/{jobUuid}/items` — từng dòng dữ liệu + lỗi |
| POST | `/task-import-jobs/{jobUuid}/retry` |

### External storage — `ExternalStorageController` (`/external-storage`)

Nhóm CRUD lớn nhất project (≈28 endpoint):

```
/profiles          — kết nối tới S3/MinIO/SFTP (+ credentials, enable/disable, test-connection, delete)
/schedules         — lịch quét (+ run-now, enable/disable, update, delete)
/runs              — 1 lần chạy lịch (+ retry, cancel, hide)
/batches           — 1 thư mục batch phát hiện được (+ retry, hide)
/jobs              — job import sinh ra từ batch (+ files)
```

`ExternalAssetController` (`/external-assets/{assetRef}`) — proxy file media của external
storage cho app xem, token TTL `asset-proxy-token-ttl-seconds: 900`.

---

## 3. Business logic

```
TaskImportController → TaskImportService → TaskImportServiceImpl
    ├── ProjectReadinessValidator      (project có sẵn sàng nhận import không)
    ├── TaskImportFileValidator        (kích thước, MIME, số dòng)
    ├── LabelConfigDataKeyResolver     (label_config XML → data key bắt buộc)
    ├── TaskImportParserFactory        → JSON / CSV / TSV / TXT parser
    ├── ImportItemPlanner              (lập ExecutionPlan, tái dùng item cũ khi retry)
    ├── ImportFileStorage              (FILE_SERVICE | LOCAL)
    ├── LabelStudioImportClient        → POST /api/projects/{id}/import
    └── ImportMirrorExecutor           → TaskMirrorServiceImpl → tasks local

TaskImportWorkerJob (async)  ← lấy job PENDING/RETRYING/WAITING và chạy cùng pipeline

ExternalStorageSchedulerTick
    ├── ScheduleFireEvaluator          (đến giờ chưa? CronCompiler)
    ├── ExternalStorageRunService      (tạo ExternalStorageRun)
    └── ExternalStorageScanService     → ExternalStorageProvider (S3 / MinIO / SFTP)
                                       → ExternalImportJobFactory → TaskImportJob
```

---

## 4. Persistence

| Entity | Table | Ý nghĩa |
|---|---|---|
| `TaskImportJob` | `task_import_jobs` | 1 lần import; giữ `status`, `ls_import_id`, `total/success/failed/skipped_count`, `attempt_count`, `batch`, `file_count` |
| `TaskImportJobFile` | `task_import_job_files` | file trong job batch |
| `TaskImportItem` | `task_import_items` | **1 dòng dữ liệu** → 1 task; giữ `ls_task_id` sau khi tạo |
| `TaskImportSftpSource` / `TaskImportSftpFile` | `task_import_sftp_*` | nguồn SFTP cũ |
| `ExternalStorageProfile` | `external_storage_profiles` | kết nối S3/MinIO/SFTP, credential **mã hoá AES-GCM** |
| `ExternalStorageSchedule` | `external_storage_schedules` | lịch quét |
| `ExternalStorageRun` | `external_storage_runs` | 1 lần chạy lịch |
| `ExternalImportBatch` / `ExternalImportBatchJob` | `external_import_batches` / `_batch_jobs` | 1 thư mục batch, và job sinh ra |
| `ExternalTaskAsset` | `external_task_assets` | file media đi kèm task |
| `ExternalDuplicateRegistryEntry` | `external_duplicate_registry` | chống import trùng |

---

## 5. Integration

| Hệ thống | Client | Mục đích |
|---|---|---|
| **Label Studio** | `LabelStudioImportClient` (`RestTemplate` multipart) | `POST /api/projects/{id}/import`, poll `GET .../imports/{importId}` |
| **file-service** | `FileServiceApiImplClient` | lưu file upload (`task-import.storage.provider: FILE_SERVICE`) |
| **S3 / MinIO** | `S3ExternalStorageProvider` (AWS SDK v2, path-style cho MinIO) | list / stream / move file |
| **SFTP** | `SftpExternalStorageProvider` (Apache Mina SSHD) | list / stream / move file |
| Local disk | `LocalDiskExternalStorageProvider` | dev; `local-provider-enabled: false` mặc định |

> `ExternalProviderType` chỉ có `S3, MINIO, SFTP` — `LocalDiskExternalStorageProvider` tồn tại
> trong code nhưng không có giá trị enum tương ứng; nó được gate bằng
> `task-import.external-storage.local-provider-enabled`.

---

## 6. Background processing

| Job | Nhịp | Điều kiện bật | Làm gì |
|---|---|---|---|
| `TaskImportWorkerJob.scan` | `fixedDelay` `task-import.worker.fixed-delay-ms` = 10s | luôn | claim job PENDING/RETRYING/WAITING → chạy pipeline |
| `ExternalStorageSchedulerTick.tick` | cron `0 * * * * *` (mỗi phút) | `task-import.external-storage.enabled=true` | duyệt schedule đến hạn → tạo run → scan |
| `SftpImportScannerJob` | cron `task-import.sftp.scan-cron` = `0 */5 * * * *` | `task-import.sftp.enabled=true` (**mặc định false**) | quét SFTP source → tạo `TaskImportJob` |

---

## 7. Important flows

### 7.1 Vòng đời `TaskImportJob` — state machine

```
PENDING → STORED → VALIDATING ─┬─► VALIDATION_FAILED   (terminal cho job này, phải tạo job mới)
                               │
                               └─► QUEUED → IMPORTING_TO_LABEL_STUDIO
                                              ├─► WAITING_LABEL_STUDIO_IMPORT  (LS xử lý async → poll)
                                              └─► SYNCING_LOCAL_TASKS
                                                     ├─► COMPLETED
                                                     ├─► PARTIAL_FAILED
                                                     ├─► FAILED_RETRYABLE → RETRYING → …
                                                     └─► FAILED_PERMANENT
```

Enum tự bảo vệ mình:

```java
TERMINAL  = {COMPLETED, FAILED, FAILED_PERMANENT, CANCELLED}
RETRYABLE = {FAILED_RETRYABLE, PARTIAL_FAILED, WAITING_LABEL_STUDIO_IMPORT}

canTransitionTo(next):
   next == null            → false
   this == next            → true
   isTerminal()            → false       ← job đã xong thì KHÔNG BAO GIỜ đổi nữa
   this == VALIDATION_FAILED → false
   ngược lại               → true
```

Javadoc giải thích: *"a slow concurrent writer regressing COMPLETED back to VALIDATING corrupts
the Portal's view."*

**Evidence:** `enums/taskimport/ImportJobStatus.java`

### 7.2 Claim job — chống chạy trùng giữa nhiều instance

Đây là **cơ chế concurrency quan trọng nhất** của module này:

```java
for (TaskImportJob job : ready) {
  ImportJobStatus entry = job.getStatus();
  if (!jobService.claimStatus(job.getId(), entry, ImportJobStatus.QUEUED)) {
    continue;   // luồng/instance khác đã thắng
  }
  processJob(job.getId(), entry);
}
```

`claimStatus` = **compare-and-set trên cột `status`** (`UPDATE ... SET status='QUEUED'
WHERE id=? AND status=?`, kiểm tra số row bị ảnh hưởng). Đây là distributed lock "nghèo"
nhưng hiệu quả — **không cần Redis/ZooKeeper**, và là cách duy nhất trong codebase chống
duplicate execution giữa các replica.

### 7.3 Reclaim job mồ côi

Instance chết sau khi claim → job kẹt `QUEUED` mãi mãi. `reclaimStaleQueued()` xử lý:

```
STALE_QUEUED_MS = 15 phút
job.modifiedTime < now - 15p  ⇒  re-arm:
    lsImportId != null → WAITING_LABEL_STUDIO_IMPORT   (LS đã nhận rồi → chỉ poll lại, KHÔNG import lại)
    lsImportId == null → PENDING                       (chạy lại full pipeline)
```

### 7.4 Retry idempotency

Javadoc `TaskImportWorkerJob`:

> *"Retry idempotency: item rows are ensured (reused) by `ImportItemPlanner`; only items without
> an `lsTaskId` are sent to Label Studio, items already created on LS get their local mirror
> repaired instead."*

⇒ Retry một job **không** tạo task trùng trên LS. `task_import_items.ls_task_id` là dấu vết.

### 7.5 Sync vs Async mode

`TaskImportProperties.portal`:

| | SYNC | ASYNC |
|---|---|---|
| Max file size | `sync-max-file-size-bytes` = 10 MB | `async-max-file-size-bytes` = 200 MB |
| Max items | `sync-max-items` = 1 000 | `async-max-items` = 100 000 |
| Chờ | `sync-wait-timeout-seconds` = 30 | trả `jobUuid` ngay, poll `/task-import-jobs/{uuid}` |

Batch: tối đa `batch-max-files` = 100 file, `batch-max-total-bytes` = 1 GB.

### 7.6 External storage scheduled import

```
ExternalStorageSchedulerTick (mỗi phút)
   ↓ scheduleRepository.findAllEnabled()
   ↓ ScheduleFireEvaluator.evaluate(schedule, now)   → FireDecision
   ↓ ExternalStorageRunService.createRun(schedule, RunTriggerSource.SCHEDULE)
   │     status SKIPPED_ALREADY_RUNNING / SKIPPED_DISABLED → dừng
   ↓ ExternalStorageScanService.scan(schedule, run)
        ↓ ExternalStorageProvider.list(...)   (S3 / MinIO / SFTP)
        ↓ phát hiện batch folder + đọc manifest
        ↓ ExternalImportJobFactory → TaskImportJob(source = EXTERNAL_STORAGE_SCHEDULED)
        ↓ TaskImportWorkerJob nhặt lên chạy tiếp
        ↓ ExternalStorageArchiveService: move file đã xử lý sang
             {root}/{projectUuid}/{yyyy}/{MM}/{dd}/{batchId}/{relative}
```

`ExternalRunStatus`: `CREATED → SCANNING → REGISTERED_BATCHES → COMPLETED`,
hoặc `SKIPPED_DISABLED | SKIPPED_ALREADY_RUNNING | FAILED | CANCELLED`.

**Evidence:** `job/taskimport/external/ExternalStorageSchedulerTick.java:53-84`

### 7.7 Credential của external storage

Hai nguồn, chọn bằng `ProviderCredentialResolver`:

- `EnvBackedProviderCredentialResolver` — đọc từ config
  (`external-storage.secrets.*`), bật bằng `env-credentials-enabled: true`.
- `DbBackedProviderCredentialResolver` — user tự nhập, lưu trong
  `external_storage_profiles` và **mã hoá bằng `AesGcmSecretCipher`** với key từ
  `external-storage.crypto.keys.{active-key-id}`.

---

## 8. Risk

| Rủi ro | Xử lý trong source |
|---|---|
| Nhiều replica chạy trùng job | `claimStatus` compare-and-set trên cột status |
| Instance chết giữa chừng | `reclaimStaleQueued()` sau 15 phút |
| Retry tạo task trùng trên LS | `ImportItemPlanner` chỉ gửi item chưa có `ls_task_id` |
| LS import chậm | `import-poll-interval-seconds: 3`, `import-poll-timeout-seconds: 600` |
| Import trùng file | `external_duplicate_registry` + `duplicate-policy: SKIP_BY_SOURCE_KEY` |
| File quá lớn | giới hạn per-format (`image` 50MB, `audio` 200MB, `video` 1GB, `pdf` 200MB, `hypertext` 25MB) |
| Retry backoff | `task-import.retry`: `max-attempts: 3`, `initial-delay-seconds: 30`, `max-delay-seconds: 600` |
| Một schedule đè lên chính nó | `SKIPPED_ALREADY_RUNNING` |
| Hai schedule cùng project | migration `V29__external_storage_schedule_unique_active_project.sql` |

**Chưa đủ evidence trong source để kết luận** về việc `ExternalStorageSchedulerTick` có chống
chạy song song giữa nhiều replica hay không — nó chỉ dựa vào `SKIPPED_ALREADY_RUNNING` ở tầng
run, không có distributed lock ở tầng tick.

---

## 9. Diagram

Xem `task-import.d2`.
