# Domain: Task & Assignment (phân phối task)

> Đây là **domain lõi** của Questlab. Nếu chỉ có thời gian đọc 1 domain, đọc domain này.

---

## 1. Purpose — domain này giải quyết nghiệp vụ gì?

Questlab là nền tảng **crowdsourcing gán nhãn dữ liệu (data labeling)**. Người dùng (annotator)
mở app, bấm "nhận việc", hệ thống phải chọn ra **một task phù hợp** và **giao độc quyền có
thời hạn** cho người đó.

Bài toán khó nằm ở 5 ràng buộc phải đồng thời đúng:

1. **Overlap** — mỗi task cần được N người **khác nhau** gán nhãn độc lập (`tasks.overlap`)
   để đo đồng thuận. Không được cấp quá N suất.
2. **Không lặp người** — cùng một user không được nhận lại task mình đã làm.
3. **Eligibility** — user phải khớp *Project Assignment Policy* (điều kiện dựa trên profile).
4. **Qualification gate** — nếu project thuộc campaign yêu cầu bài test, user phải PASS trước.
5. **Race condition** — hai user bấm cùng lúc không được nhận trùng task.

---

## 2. Entry points

| Method | Endpoint | Controller | Mục đích |
|---|---|---|---|
| POST | `/assignments/request` | `AssignmentController.requestTask` | User tự xin task mới (luồng chính) |
| GET | `/assignments` | `AssignmentController.getMyAssignments` | Danh sách assignment của tôi |
| POST | `/assignments/admin/direct` | `AssignmentController.directAssign` | Admin/demo gán tay cho 1 user trong 1 project |
| GET | `/tasks/my-assigned` | `TaskController.getMyAssignedTasksInProject` | Assignment của tôi trong 1 project, có filter/sort/`statusCounts` |
| GET | `/tasks/{taskId}` | `TaskController.getTaskById` | Chi tiết task (data lấy từ Label Studio, media URL được ký lại) |
| GET | `/tasks/assignable` | `TaskController.getAssignableTasks` | Task còn suất overlap |
| POST | `/assignments/recommendations/{id}/assign` | `TaskRecommendationController` | Nhận task từ gợi ý "Dành cho bạn" |
| POST | `/integration/tasks/request` | `IntegrationController` | Partner SDK xin task (pool chung, xem `partner-integration.md`) |

**Evidence:**
- `questlab-service/src/main/java/com/ttt/questlab/controller/AssignmentController.java`
- `questlab-service/src/main/java/com/ttt/questlab/controller/TaskController.java`

---

## 3. Business logic

```
AssignmentController
    ↓
TaskDistributionService (interface)
    ↓
TaskDistributionServiceImpl
    ├── AssignedTaskRepository      (quota, tạo assignment)
    ├── AuthProfileClient           → auth-service (profile của user)
    ├── AssignmentProfileContextBuilder  (flatten profile → context)
    ├── ProjectEligibilityService   → ProjectAssignmentPolicyService + AssignmentPolicyEvaluator
    ├── QualificationAssignmentGate → CampaignProjectRepository + CampaignQualificationConfigRepository
    ├── TaskRepository              (query chọn task + FOR UPDATE)
    └── ProjectRepository
```

**Evidence:** `service/impl/TaskDistributionServiceImpl.java:50-139`

### Luồng `requestTask(userId)` — đọc kỹ 8 bước

`TaskDistributionServiceImpl.requestTask` được đánh dấu `@Transactional` (dòng 70). Toàn bộ 8
bước dưới đây chạy trong **một transaction duy nhất**:

| # | Bước | Code |
|---|---|---|
| 1 | **Quota** — đếm assignment `PENDING` của user, ≥ `assignment.max-concurrent-tasks` (=10) thì từ chối | `checkUserQuota()` → `assignedTaskRepository.countActiveByUserId` |
| 2 | **Lấy profile** từ auth-service. Lỗi → `AuthProfileUnavailableException` (503, retryable), **không** gán bừa | `authProfileClient.getUserProfile(userId)` |
| 3 | **Build context** — flatten profile thành map field phẳng để evaluator dùng | `profileContextBuilder.build(profile)` |
| 4 | **Lọc project đủ điều kiện** — chạy policy của từng project ACTIVE + MATCHED | `projectEligibilityService.findEligibleProjects` |
| 5 | **Qualification gate** — loại project của campaign yêu cầu test mà user chưa PASS. Cố ý **loại khỏi candidate chứ không throw**, vì một request quét nhiều project | `qualificationAssignmentGate.blockedProjectIds` (dòng 96-110) |
| 6 | **Chọn task + KHOÁ ROW** | `taskRepository.findNextAssignableTaskId(...)` — native SQL có `FOR UPDATE` |
| 7 | **Tạo assignment** `PENDING`, `expiredAt = now + assignment.expiry.minutes` (=4320 phút = 3 ngày), kèm **snapshot** profile/policy | `createAssignment()` |
| 8 | **Đổi task status** `AVAILABLE → IN_PROGRESS` (chỉ khi đang AVAILABLE) | `updateTaskStatusIfNeeded()` |

Khi không tìm được gì, method **trả về `RequestTaskResult` có `message` mô tả lý do**, HTTP vẫn
200 và `data = null` — chứ không ném exception. Các message thực tế trong source:
`"No eligible projects for current user profile."`,
`"You must pass the campaign qualification test before receiving its tasks."`,
`"No tasks available for eligible projects."`,
`"You have reached the maximum concurrent tasks (N)."`

---

## 4. Persistence

| Entity | Table | Repository | Ý nghĩa nghiệp vụ |
|---|---|---|---|
| `Task` | `tasks` | `TaskRepository` | 1 đơn vị dữ liệu cần gán nhãn; mirror của LS task (`ls_task_id` unique) |
| `AssignedTask` | `assigned_tasks` | `AssignedTaskRepository` | 1 lượt giao task cho 1 user, có hạn |
| `TaskAnnotation` | `task_annotations` | `TaskAnnotationRepository` | Kết quả gán nhãn user submit |
| `Project` | `projects` | `ProjectRepository` | Mirror của LS project |
| `ProjectAssignmentPolicy` | `project_assignment_policies` | `ProjectAssignmentPolicyRepository` | Điều kiện eligibility, có version + hash |

### Cột quan trọng

`tasks`: `overlap` (số người cần), `annotation_count` (đã có bao nhiêu annotation),
`task_status` ∈ `UNAVAILABLE | AVAILABLE | IN_PROGRESS | COMPLETED`, `ls_task_id`, `data_json`.

`assigned_tasks`: `status` ∈ `PENDING | ANNOTATED | EXPIRED | CANCELLED`,
`assigned_at`, `expired_at`, **`version` (`@Version` — optimistic locking)**, và 4 cột snapshot:
`profile_context_json`, `matched_policy_version`, `matched_policy_hash`, `match_reason_json`.

> **Vì sao có snapshot?** Để sau này audit được "tại thời điểm gán, user này khớp policy version
> mấy, vì điều kiện nào". Policy có thể đổi sau đó. Serialize lỗi thì ghi `null` chứ **không** làm
> hỏng assignment (`writeJsonOrNull`, dòng 384-392).

**Evidence:** `entities/Task.java`, `entities/AssignedTask.java`, `entities/ProjectAssignmentPolicy.java`

---

## 5. Integration

| Hệ thống ngoài | Gọi ở đâu | Mục đích |
|---|---|---|
| **auth-service** | `AuthProfileClient.getUserProfile` (trong `requestTask`) | Lấy profile để đánh giá eligibility |
| **Label Studio** | `LabelStudioClient` (ở `TaskServiceImpl.getTaskById`, `AnnotationServiceImpl`) | Lấy nội dung task, tạo/sửa annotation |

Assignment **không** được đẩy sang Label Studio. Label Studio không biết Questlab đang giao task
cho ai — xem `label-studio-sync.md` §Source of Truth.

---

## 6. Background processing

| Job | Cron (default) | Làm gì |
|---|---|---|
| `AssignmentExpiryJob` | `assignment.expiry.cron` = `0 0/10 * * * *` (10 phút/lần) | `PENDING` quá `expired_at` → `EXPIRED`; task không còn `PENDING` và chưa đủ `ANNOTATED` → trả về `AVAILABLE`; đẩy user vào watchlist Redis |

**Evidence:** `job/AssignmentExpiryJob.java:37-58`

Chuỗi thao tác trong job (thứ tự quan trọng):

```
findDistinctUserIdsPendingExpiredBefore(now)   ← đọc TRƯỚC khi update, vì sau update sẽ không còn PENDING
    ↓
markExpiredBefore(now)                          ← bulk UPDATE ... SET status='EXPIRED'
    ↓
revertToAvailableWhereNoPending(now)            ← bulk UPDATE tasks SET task_status='AVAILABLE'
    ↓
recommendationCacheService.enqueueWatchlist(userId)  ← Redis hash
```

---

## 7. Important flows

### 7.1 Query chọn task — `TaskRepository.findNextAssignableTaskId`

Native SQL, đây là trái tim của domain:

```sql
SELECT t.id FROM tasks t
WHERE t.ls_deleted = false
  AND t.is_deleted = false
  AND t.task_status IN ('AVAILABLE', 'IN_PROGRESS')
  AND t.project_id IN (:eligibleProjectIds)
  -- (2) còn suất overlap
  AND (SELECT COUNT(*) FROM assigned_tasks a
       WHERE a.task_id = t.id
         AND a.status IN ('PENDING','ANNOTATED')
         AND a.is_deleted = false) < t.overlap
  -- (3) user chưa nhận task này
  AND NOT EXISTS (SELECT 1 FROM assigned_tasks a
                  WHERE a.task_id = t.id AND a.user_id = :userId
                    AND a.status IN ('PENDING','ANNOTATED') AND a.is_deleted = false)
  -- (4) guard max_overlap_ratio: hạn chế 2 user cùng đụng quá nhiều task chung
  AND NOT EXISTS ( ...correlated subquery 3 tầng... )
ORDER BY
  CASE WHEN t.task_status = 'IN_PROGRESS' THEN 0 ELSE 1 END ASC,  -- lấp đầy slot dở trước
  t.id ASC                                                        -- FIFO
LIMIT 1
FOR UPDATE
```

**Giải thích từng phần:**

- **`task_status IN ('AVAILABLE','IN_PROGRESS')`** — task đang có người làm dở vẫn cấp tiếp
  được, vì `overlap` cho phép nhiều người. Chỉ `COMPLETED`/`UNAVAILABLE` mới loại.
- **`ORDER BY IN_PROGRESS trước`** — chủ ý nghiệp vụ: ưu tiên **lấp đầy** task đã có 1-2 người
  làm để nó sớm đủ overlap và `COMPLETED`, thay vì rải mỏng ra nhiều task mới.
- **`max_overlap_ratio`** — chặn hiện tượng hai annotator luôn được ghép cùng nhau (làm số liệu
  đồng thuận mất tính độc lập). Ngưỡng = `FLOOR(tổng_task_project * max_overlap_ratio)`,
  `= 0` nghĩa là cấm hoàn toàn trùng cặp.
- **`FOR UPDATE`** — xem §8.

**Performance concern (đã ghi ngay trong javadoc của repository):** điều kiện (4) là
correlated subquery 3 tầng chạy trên mỗi row `tasks`. Javadoc đề nghị index
`assigned_tasks(project_id, user_id, status)` khi dataset lớn.

**Evidence:** `repository/TaskRepository.java:102-180`

### 7.2 Submit annotation

```
POST /annotations?assignedTaskId=...
    ↓ AnnotationController.createNewAnnotation
    ↓ AnnotationServiceImpl.createAnnotation  @Transactional
    1. assignedTaskRepository.findByUuidAndStatus(id, PENDING)  → 404 nếu không có
    2. check expiredAt < now                                    → BadRequestException
    3. check assignedTask.userId == userId                      → UnAuthorizedException
    4. taskRepository.findById → check status != UNAVAILABLE
    5. validationOrchestrator.validate(request, projectId)      ← validate theo label_config của project
    6. labelStudioClient.createAnnotation(payload, lsTaskId)    ← GỌI RA NGOÀI, trong transaction
    7. saveAnnotationAndUpdateStatus(...)
         - INSERT task_annotations
         - assigned_tasks.status = ANNOTATED
         - tasks.annotation_count += 1
         - nếu annotation_count+1 >= overlap → tasks.task_status = COMPLETED
    8. recommendationCacheService.enqueueWatchlist(userId)      ← Redis
```

**Evidence:** `service/impl/AnnotationServiceImpl.java:49-131`

---

## 8. Risk — Transaction, concurrency, locking

### 8.1 Race "hai user cùng xin task" — được xử lý thế nào?

Đây là câu hỏi phỏng vấn số 1 của project này.

```
User A                              User B
  |                                   |
  | BEGIN TX                          | BEGIN TX
  | SELECT ... FOR UPDATE  ──────►    |
  | (khoá row task #100)              | SELECT ... FOR UPDATE
  |                                   | ⏸ BLOCKED (chờ row #100)
  | INSERT assigned_tasks             |
  | UPDATE tasks SET IN_PROGRESS      |
  | COMMIT ──────────────────────►    |
  |                                   | ▶ unblock, InnoDB dùng CURRENT READ
  |                                   |   → đọc lại assigned_tasks với data mới
  |                                   |   → điều kiện overlap/dedup được đánh giá lại
  |                                   |   → nếu hết suất, task #100 bị loại, chọn task khác
```

Cơ chế: **pessimistic row lock qua `SELECT ... FOR UPDATE`** trên bảng `tasks`, kết hợp việc
InnoDB thực hiện *current read* (đọc bản mới nhất, không phải snapshot MVCC) khi transaction
thứ hai được đánh thức. Chính javadoc của repository giải thích điều này:

> *"FOR UPDATE: lock row tasks được chọn. InnoDB dùng current read khi T2 unblock sau T1 commit,
> nên assigned_tasks được re-read với data mới nhất → serialization đúng."*
> — `TaskRepository.java:109-110`

**Điểm cần lưu ý khi review:** lock đặt trên row `tasks`, còn điều kiện overlap đếm trên
`assigned_tasks`. Việc này an toàn vì mọi đường cấp task đều phải qua row `tasks` đó trước
(`findNextAssignableTaskId`, `lockRecommendedTaskForUser`,
`findNextAvailableTaskIdOutsideGatedCampaigns` — cả ba đều `FOR UPDATE` trên `tasks`).

### 8.2 `@Version` trên `AssignedTask`

`AssignedTask.version` có `@Version` → optimistic locking. Nó bảo vệ trường hợp hai luồng cùng
`save()` một assignment (ví dụ submit annotation đồng thời với expiry job) — luồng thua nhận
`OptimisticLockingFailureException`.

### 8.3 Gọi HTTP ra ngoài **bên trong** transaction

`AnnotationServiceImpl.createAnnotation` là `@Transactional` nhưng gọi
`labelStudioClient.createAnnotation` (HTTP, response timeout **120 giây** theo
`RestTemplateConfig.RESPONSE_TIMEOUT_MS`) ở giữa transaction.

Hệ quả cần biết khi debug: DB connection bị giữ suốt thời gian chờ Label Studio. Khi LS chậm,
pool connection có thể cạn. Đây là đặc điểm hiện có của source, **không phải** khuyến nghị.

Tương tự, `requestTask` gọi `authProfileClient.getUserProfile` bên trong `@Transactional`.

### 8.4 Idempotency

- `POST /assignments/request` **không idempotent** — gọi 2 lần thì nhận 2 task khác nhau
  (bị chặn bởi quota `max-concurrent-tasks`).
- `POST /annotations` **không idempotent** — nhưng bước 1 yêu cầu assignment đang `PENDING`;
  sau lần submit đầu status đổi thành `ANNOTATED` nên lần 2 sẽ 404
  `"No active assignment found for this task."` → **de-facto idempotent**.
- Ngược lại, module Compensation **có** idempotency key thật (xem `compensation-payout.md`).

### 8.5 `@Async` + `@Transactional` không đi cùng nhau

`SyncServiceImpl` các handler webhook là `@Async("lsSyncExecutor")` nhưng **không** có
`@Transactional`. Mỗi lệnh repository tự chạy transaction riêng (`@Modifying @Transactional`
đặt ở tầng repository). Nghĩa là một webhook xử lý nửa chừng lỗi sẽ để lại trạng thái *một
phần* — nhưng vì các lệnh đều là `INSERT IGNORE` / `UPDATE ... WHERE` idempotent nên lần
reconcile sau sẽ chữa lại.

### 8.6 `revalidateAndAssign` — bẫy `protected` + self-invocation

`RecommendedTaskAssignmentServiceImpl.revalidateAndAssign` khai báo
`@Transactional protected` và được gọi từ `assign()` **trong cùng class**. Spring AOP proxy
không chặn được self-invocation → annotation `@Transactional` này **không có hiệu lực**.
Việc chọn task vẫn an toàn vì `lockRecommendedTaskForUser` có `FOR UPDATE` (query tự mở
transaction riêng), nhưng đây là điểm cần biết khi debug.

**Evidence:** `service/impl/RecommendedTaskAssignmentServiceImpl.java:124-128`

---

## 9. Diagram

Xem `task-assignment.d2`.
