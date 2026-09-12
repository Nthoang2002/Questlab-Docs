# Domain: Label Studio Integration

---

## 1. Architecture — ai đóng vai gì?

**Label Studio (LS)** là một sản phẩm open-source làm *annotation workbench*: nó giữ định nghĩa
giao diện gán nhãn (`label_config` XML), giữ nội dung task (ảnh/text/audio…), và lưu annotation.

**Questlab** là lớp **quản trị đám đông (crowdsourcing layer)** đặt phía trước LS. Nó làm những
việc mà LS không làm:

| Việc | Label Studio | Questlab |
|---|---|---|
| Định nghĩa giao diện gán nhãn (`label_config`) | ✅ chủ | mirror |
| Lưu nội dung task | ✅ chủ | mirror (`tasks.data_json`) |
| Lưu annotation | ✅ chủ | mirror (`task_annotations`) |
| **Ai được nhận task nào** | ❌ | ✅ |
| **Giao task có thời hạn, overlap, quota** | ❌ | ✅ |
| **Campaign / qualification test / thù lao** | ❌ | ✅ |
| **Người dùng end-user (annotator)** | ❌ (chỉ có user nội bộ) | ✅ qua auth-service |

Nói ngắn: **LS là kho dữ liệu + trình soạn nhãn; Questlab là hệ điều phối nhân lực.**

App/mobile **không gọi thẳng LS** — mọi thứ đi qua Questlab. Ngay cả file media của LS cũng
được Questlab proxy lại qua `/media/**` với signed URL (xem §7).

```
Mobile App ──► Questlab ──► Label Studio ──► (S3/MinIO/local storage)
```

---

## 2. Các kênh đồng bộ — có 3 kênh, không phải 1

| # | Kênh | Hướng | Trigger | Class |
|---|---|---|---|---|
| 1 | **Webhook** | LS → Questlab | LS bắn event realtime | `LsWebhookController` → `SyncServiceImpl.handle*` |
| 2 | **Reconciliation** | Questlab kéo từ LS | Cron `0 */3 * * * *` (3 phút) | `ReconciliationJob` → `SyncServiceImpl.reconcile*` |
| 3 | **Command / write** | Questlab → LS | User thao tác | `LabelStudioClient`, `LabelStudioImportClient` |

Kênh 1 là *fast path*, kênh 2 là *safety net* (webhook mất thì 3 phút sau reconcile chữa lại).

---

## 3. Project Sync

### 3.1 Webhook `PROJECT_CREATED` / `PROJECT_UPDATED` / `PROJECT_DELETED`

`POST /internal/webhooks/label-studio` → `LsWebhookController.receive`:

- Parse body thành `LsWebhookPayload`; parse lỗi → `400`.
- Switch theo `payload.action`, gọi method `@Async("lsSyncExecutor")` của `SyncService`.
- **Trả `200 OK` ngay lập tức**, không chờ xử lý xong.

```java
case "PROJECT_CREATED" -> syncService.handleProjectCreated(payload.getProject());
case "PROJECT_UPDATED" -> syncService.handleProjectUpdated(payload.getProject());
case "PROJECT_DELETED" -> syncService.handleProjectDeleted(payload.getProject().getId());
case "TASK_CREATED"    -> syncService.handleTasksCreated(...);
case "TASK_DELETED"    -> syncService.handleTasksDeleted(...);
default -> log.warn(...)
```

**Evidence:** `webhook/LsWebhookController.java:44-72`

### 3.2 Template gate — điểm nghiệp vụ quan trọng nhất của project sync

Questlab **không nhận mọi project của LS**. Mỗi project LS mang một `label_config` XML.
Questlab chuẩn hoá XML đó (`TemplateNormalizer`) rồi so khớp với danh mục
`annotation_templates` mà team đã hỗ trợ (`ProjectTemplateMatcher`).

```
label_config XML
    ↓ TemplateNormalizer (normalizerVersion)
logic signature (hash)
    ↓ ProjectTemplateMatcher.resolve()
MatchContext { templateId, matchStatus, logicSignature, normalizerVersion }
```

Kết quả quyết định trạng thái:

| `templateMatchStatus` | `projects.project_status` | `tasks.task_status` khi tạo |
|---|---|---|
| `MATCHED` | `ACTIVE` | `AVAILABLE` |
| `UNMATCHED` / `UNSUPPORTED` | `INACTIVE` | `UNAVAILABLE` |

Vì `ProjectEligibilityServiceImpl.findEligibleProjects` chỉ lấy project
`ACTIVE + MATCHED`, project không khớp template **sẽ không bao giờ được phân phối**.

Gate bật/tắt bằng `sync.template-gate.enabled` (default `true`).

**Evidence:** `service/impl/SyncServiceImpl.java:65-95`, `:97-137`, `:139-181`

### 3.3 Reconciliation project — `SyncServiceImpl.reconcileProjects()`

```
FETCH  : fetchAllProjects()  ← phân trang LS, sleep sync.reconciliation.page-delay-ms giữa các trang
SAFETY : nếu LS trả về rỗng → ABORT (không xoá gì), ghi SyncJobLog "empty list from LS — aborted"
DIFF   : lsIds vs dbIds  →  toInsert / toUpdate / toDelete
APPLY  : insertIfAbsent | updateFromWebhook | markLsDeletedByLsIds
LOG    : ghi sync_job_log (records processed/inserted/updated/deleted/skipped)
```

**Safety check là chi tiết đáng học**: nếu LS trả list rỗng (do lỗi mạng, LS restart), code
**không** coi đó là "LS đã xoá hết project" mà dừng lại. Nếu không có guard này, một sự cố
tạm thời của LS sẽ xoá sạch mirror.

**Evidence:** `service/impl/SyncServiceImpl.java:196-342`

---

## 4. Task Sync

### 4.1 Chiều LS → Questlab

- Webhook `TASK_CREATED` → `handleTasksCreated(lsProjectId, tasks)`:
  tìm project local; nếu project chưa tồn tại thì **bỏ qua** (log warn). Nếu project
  `UNMATCHED` thì vẫn insert task nhưng với status `UNAVAILABLE`.
  Insert bằng `taskRepository.insertIfAbsent` — native `INSERT IGNORE` → **idempotent**,
  webhook gửi trùng không tạo bản ghi thừa.
- Webhook `TASK_DELETED` → `handleTasksDeleted`:
  **`cancelActiveByLsTaskIds` chạy TRƯỚC `markLsDeletedByLsIds`** — huỷ mọi assignment
  `PENDING` trước khi đánh dấu task đã xoá, để user không submit annotation lên task không
  còn tồn tại.
- Reconcile: `reconcileTasksForProject(lsProjectId)` cho từng project ACTIVE.

### 4.2 Safety check tinh vi hơn ở task reconcile

Ở project reconcile, "rỗng = đáng ngờ". Ở task reconcile, LS có thể **thật sự** có 0 task.
Code phân biệt hai trường hợp bằng field `total` mà LS trả về:

```java
if (lsTaskMap.isEmpty()) {
  if (fetchResult.reportedTotal() != null && fetchResult.reportedTotal() == 0) {
    // LS xác nhận total = 0 → tin được → tiếp tục xoá task local
  } else {
    // rỗng nhưng không rõ lý do → ABORT
  }
}
```

**Evidence:** `service/impl/SyncServiceImpl.java:364-382`

### 4.3 Chiều Questlab → LS (tạo task mới)

Questlab đẩy task **lên** LS qua module Task Import (xem `task-import.md`):
`LabelStudioImportClient.importTasks` / `uploadFile` →
`POST /api/projects/{lsProjectId}/import`, rồi poll
`GET /api/projects/{id}/imports/{importId}` nếu LS xử lý bất đồng bộ.

---

## 5. Assignment — LS **không** tham gia

Toàn bộ việc "user nào nhận task nào" nằm trong Questlab (`assigned_tasks`).
Không có API call nào từ `TaskDistributionServiceImpl` sang LS.

Điều này là **cố ý**: `assignment_settings` của LS được thiết kế cho đội annotator nội bộ,
không đủ cho mô hình crowdsourcing (quota, expiry, policy theo profile, campaign, thù lao).

---

## 6. Annotation

Annotation đi **cả hai chiều**:

```
POST /annotations (user submit)
   ↓ AnnotationServiceImpl.createAnnotation  @Transactional
   ├─ validationOrchestrator.validate(request, projectId)     ← check theo label_config
   ├─ labelStudioClient.createAnnotation(payload, lsTaskId)   ← GHI VÀO LS TRƯỚC
   │      POST {base}/api/tasks/{lsTaskId}/annotations
   └─ lưu mirror local:
        INSERT task_annotations (ls_annotation_id ← id LS trả về, result_json, lead_time)
        assigned_tasks.status = ANNOTATED
        tasks.annotation_count += 1
        nếu đủ overlap → tasks.task_status = COMPLETED
```

**Thứ tự này quan trọng:** LS là nơi ghi trước và cấp `ls_annotation_id`. Nếu LS lỗi,
exception bay lên, transaction rollback, không có mirror mồ côi.

`updateAnnotation` gọi `PATCH {base}/api/annotations/{lsAnnotationId}`.

**Evidence:** `service/impl/AnnotationServiceImpl.java:76-131`, `client/LabelStudioClient.java:79-113`

---

## 7. Media — signed URL proxy

Task của LS trỏ tới file (ảnh, audio, HTML…) trên storage của LS. App **không** có token LS,
gọi thẳng sẽ nhận 401. Giải pháp:

```
GET /tasks/{taskId}
   ↓ TaskServiceImpl
   ├─ labelStudioClient.getTaskById(lsTaskId)     ← lấy data gốc
   └─ rewriteMediaUrls(contentFromLB, userId)     ← thay URL LS bằng URL nội bộ đã ký

   MediaSigningServiceImpl.sign(path, userId):
     expires   = now + label-studio.media-url-ttl-minutes (10 phút)
     signature = HMAC-SHA256(path + "|" + userId + "|" + expires, media-signing-secret)
     → "/media/{path}?expires={ts}&signature={hex}"
```

Khi app tải file:

```
GET /media/**?expires=..&signature=..
   ↓ MediaController  (path này NẰM TRONG WHITE_LIST của CurrentUserFilter)
   ├─ authClient.checkAuthorization(request)      ← vẫn cần Authorization header
   ├─ tokenUserId = authClient.getUserUUIDFromToken(request)
   ↓ MediaServiceImpl.getMedia
   ├─ mediaSigningService.isValid(path, tokenUserId, expires, signature) → sai/hết hạn = 403
   ├─ mở HttpURLConnection tới LS, follow tối đa 5 redirect
   ├─ CHỈ gửi header "Authorization: Token <LS token>" khi host/port/protocol ĐÚNG là LS
   │    → khi LS redirect 303 sang S3/MinIO, token LS không bị rò ra storage
   └─ stream nội dung về client
```

Chữ ký gắn với `userId` ⇒ URL của user A dán cho user B dùng sẽ 403.

**Evidence:** `service/impl/MediaSigningServiceImpl.java`, `service/impl/MediaServiceImpl.java:36-140`,
`config/CurrentUserFilter.java:29-38`, `conventions/SIGNED_URL_DESIGN.md`

---

## 8. Reconciliation — scheduler làm gì

`ReconciliationJob.run()`, cron `sync.reconciliation.cron` = `0 */3 * * * *`:

```
1. syncService.reconcileProjects()
     lỗi → log.error + RETURN (bỏ luôn task reconcile: project sai thì task reconcile vô nghĩa)
2. syncService.reconcileTasksForLsDeletedProjects()
     lỗi → log.error + tiếp tục
3. for each lsProjectId in projectRepository.findAllActiveLsIds():
     syncService.reconcileTasksForProject(lsProjectId)
     lỗi 1 project → đếm projectsFailed, TIẾP TỤC project còn lại
4. log tổng kết: projects(i,u,d) tasks(i,u,d) taskProjects(ok,fail)
```

**Mục đích:** webhook có thể mất (LS down, network, Questlab restart, thread pool
`lsSyncExecutor` reject). Reconcile là cơ chế *eventual consistency* — chậm nhất 3 phút là
mirror khớp lại với LS.

Mỗi lần chạy ghi một dòng `sync_job_log` (`SyncJobLog.start(...)` → `SUCCESS`/`errorMessage`),
đây là **nơi đầu tiên cần nhìn khi debug sync**.

**Evidence:** `job/ReconciliationJob.java:24-72`

---

## 9. Source of Truth

| Data | Source of Truth | Ghi chú (từ source) |
|---|---|---|
| **Project (metadata, label_config)** | **Label Studio** | Questlab mirror; reconcile so `lsIds` với `dbIds`, LS thắng. **Ngoại lệ:** project do Questlab tạo (`ProjectServiceImpl` gọi `createNewProject`) và project `SURVEY` (`ls_project_id = NULL`, không tồn tại trên LS) |
| **Task (nội dung `data_json`)** | **Label Studio** | Reconcile update `data_json` từ LS đè lên local |
| **Task lifecycle (`task_status`, `overlap`, `annotation_count`)** | **Questlab** | LS không có khái niệm này |
| **Assignment** | **Questlab** | LS hoàn toàn không biết |
| **Annotation (nội dung)** | **Label Studio** | Ghi vào LS trước, `ls_annotation_id` do LS cấp; `task_annotations` là mirror |
| **Annotation (ai làm, lúc nào, thuộc assignment nào)** | **Questlab** | `task_annotations.user_id / assigned_task_id / submitted_at` |
| **Campaign / Qualification / Compensation** | **Questlab** | Không tồn tại ở LS |

---

## 10. Risk

### 10.1 Webhook không xác thực chữ ký

`application.yml` có `label-studio.webhook.secret`, nhưng:

- `LabelStudioProperties` (`@ConfigurationProperties(prefix = "label-studio")`) **không có**
  field `webhook` → property này không bind vào đâu cả.
- `LsWebhookController` **không** đọc header chữ ký nào; javadoc ghi rõ
  `[SECURITY REVIEW REQUIRED] — HMAC-SHA256 signature validation via X-LS-Signature header`
  và `[VERIFY: actual signature header name used by this LS instance]`.

⇒ Ở thời điểm đọc source, **endpoint `/internal/webhooks/label-studio` chưa verify chữ ký**.
Nó nằm ngoài `CurrentUserFilter`? — **Không**: prefix `/internal/` không có trong `WHITE_LIST`
(`/media/`, `/swagger-ui`, `/v3/api-docs`, `/swagger-resources`, `/integration/`), nên
`CurrentUserFilter` **vẫn** đòi JWT hợp lệ ở header `Authorization` cho request webhook.
Cách LS được cấu hình để gửi JWT đó — **chưa đủ evidence trong source để kết luận**.

### 10.2 Webhook chạy `@Async` với `CallerRunsPolicy`

`lsSyncExecutor`: core 3, max 20, queue 100, `CallerRunsPolicy`.
Khi burst quá 20+100, task chạy **trên chính thread HTTP của webhook** → webhook chậm lại
thay vì mất event. Đánh đổi có chủ ý (không mất event, nhưng LS có thể timeout).

**Evidence:** `config/AsyncConfig.java:19-31`

### 10.3 Không có `@Transactional` ở handler webhook

Các `handle*` không có `@Transactional`; mỗi lệnh repository là một transaction riêng
(`@Modifying @Transactional` ở tầng repository). Lỗi giữa chừng để lại trạng thái một phần,
được reconcile chữa lại sau tối đa 3 phút.

### 10.4 Reconcile là O(số project) call ra LS mỗi 3 phút

`ReconciliationJob` gọi `reconcileTasksForProject` **tuần tự** cho từng project ACTIVE, mỗi
project lại phân trang (`page-size: 50`, `page-delay-ms: 200`). Số project lớn → một vòng
reconcile có thể dài hơn 3 phút. Không thấy cơ chế chống chồng lấn (`@Scheduled` mặc định
single-threaded nên lần chạy sau sẽ bị hoãn, không chạy song song — nhưng nếu deploy nhiều
replica thì **mọi replica đều chạy job này**; không thấy distributed lock trong source).

### 10.5 Multi-replica

Không tìm thấy ShedLock/Redisson/distributed lock cho bất kỳ `@Scheduled` job nào.
Các job hiện dựa vào tính idempotent của SQL (`INSERT IGNORE`, `UPDATE ... WHERE status = ...`)
và, riêng Task Import, dùng **compare-and-set trên cột status** (`jobService.claimStatus`)
để không xử lý trùng.

---

## 11. Diagram

Xem `label-studio.d2`.
