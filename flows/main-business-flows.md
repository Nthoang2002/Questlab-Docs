# Main Business Flows — trace từ Controller đến Database / External System

Mỗi flow dưới đây có một file `.d2` sequence diagram tương ứng trong cùng thư mục.
Tất cả tên class/method là **tên thật trong source**.

| # | Flow | File D2 |
|---|---|---|
| 1 | Request Task (user xin việc) | `01-request-task.d2` |
| 2 | Submit Annotation | `02-submit-annotation.d2` |
| 3 | Label Studio Webhook | `03-label-studio-webhook.d2` |
| 4 | Reconciliation (scheduler) | `04-reconciliation.d2` |
| 5 | Assignment Expiry (scheduler) | `05-assignment-expiry.d2` |
| 6 | Task Import — Portal ASYNC | `06-task-import-async.d2` |
| 7 | External Storage Scheduled Import | `07-external-storage-import.d2` |
| 8 | Payout: request → paid | `08-payout-request-to-paid.d2` |
| 9 | Partner SDK: init → request → submit | `09-partner-sdk.d2` |
| 10 | Media signed URL | `10-media-signed-url.d2` |

---

## Flow 1 — Request Task

**Trigger:** user bấm "Nhận việc" trên app.

```
POST /assignments/request
Authorization: Bearer <JWT>
```

```
CurrentUserFilter.doFilterInternal
  authClient.getUserUUIDFromToken(request)         → UUID (từ claim "sub")
  CurrentUserContext.set(userId)                   ← dùng cho JPA auditing (creator_id)
      ↓
AssignmentController.requestTask
  authClient.checkAuthorization(servletRequest)    → thiếu header = ProxyAuthenticationException
  userId = authClient.getUserUUIDFromToken(...)
      ↓
TaskDistributionServiceImpl.requestTask(userId)    @Transactional  ◄── TX BẮT ĐẦU
  │
  ├─1─ assignedTaskRepository.countActiveByUserId(userId)
  │       SELECT COUNT(a) FROM AssignedTask a WHERE userId=? AND status='PENDING'
  │       >= assignment.max-concurrent-tasks (10) → return "You have reached the maximum..."
  │
  ├─2─ authProfileClient.getUserProfile(userId)     → HTTP GET auth-service /member-profile
  │       lỗi → AuthProfileUnavailableException → 503 (KHÔNG gán bừa)
  │
  ├─3─ profileContextBuilder.build(profile)         → AssignmentProfileContext (map phẳng)
  │
  ├─4─ projectEligibilityService.findEligibleProjects(userId, context)
  │       projectRepository.findActiveAssignableProjects(ACTIVE, MATCHED, now)
  │       for each project:
  │           policyService.getEnabledCompiledPolicy(projectId)
  │           empty  → eligible (emptyPolicyStrategy = ALLOW, §16.1)
  │           có     → policyEvaluator.evaluate(compiled, context)
  │       rỗng → return "No eligible projects for current user profile."
  │
  ├─5─ qualificationAssignmentGate.blockedProjectIds(userId, projectIds)
  │       campaignProjectRepository.findActiveCampaignLinksByProjectIds(...)
  │       configRepository.findFirstByCampaignIdAndFrozenTrue...(campaignId)
  │       attemptRepository.existsBy...(configId, userId, PASSED)
  │       loại project bị chặn; rỗng hết → return "You must pass the campaign qualification test..."
  │
  ├─6─ taskRepository.findNextAssignableTaskId(userId, eligibleProjectIds)
  │       native SQL ... ORDER BY (IN_PROGRESS trước), id ASC LIMIT 1 FOR UPDATE   ◄── KHOÁ ROW
  │       taskRepository.findById(id)
  │       empty → return "No tasks available for eligible projects."
  │
  ├─7─ createAssignment(task, userId, context, matchedProject)
  │       assignedTaskRepository.save(AssignedTask{
  │           status=PENDING, assignedAt=now,
  │           expiredAt = now + assignment.expiry.minutes (4320' = 3 ngày),
  │           profileContextJson, matchedPolicyVersion, matchedPolicyHash, matchReasonJson })
  │
  └─8─ updateTaskStatusIfNeeded(task)
          nếu AVAILABLE → taskRepository.updateTaskStatus(id, IN_PROGRESS, now)
                                                                   ◄── TX COMMIT (nhả row lock)
      ↓
GetMethodResponse{ status:true, httpCode:200, message: result.message,
                   data: AssignedTaskResponse{assignedTaskId, taskUuid, projectUuid} }
```

**Lưu ý:** khi không có task, HTTP vẫn **200** và `data = null`; lý do nằm ở `message`.

---

## Flow 2 — Submit Annotation

```
POST /annotations?assignedTaskId={uuid}
      ↓
AnnotationController.createNewAnnotation
      ↓
AnnotationServiceImpl.createAnnotation   @Transactional   ◄── TX BẮT ĐẦU
  1. assignedTaskRepository.findByUuidAndStatus(assignedTaskId, PENDING)
        → ResourceNotFoundException "No active assignment found for this task."
  2. expiredAt < now                → BadRequestException "Assignment has expired"
  3. assignedTask.userId != userId  → UnAuthorizedException "You have not permission."
  4. taskRepository.findById(...); task.status == UNAVAILABLE → BadRequestException
  5. validationOrchestrator.validate(request, task.projectId)
        → LabelConfigResolver (cache theo lsProjectId) → contract từ label_config XML
        → sai → AnnotationValidationException (trả kèm danh sách lỗi path/code/message)
  6. labelStudioClient.createAnnotation(payload, task.lsTaskId)
        POST {label-studio.base-url}/api/tasks/{lsTaskId}/annotations
        header: Authorization: Token <access-token>
        lỗi → LabelStudioException → GlobalExceptionHandler → 502/503
  7. saveAnnotationAndUpdateStatus(...)
        INSERT task_annotations (lsAnnotationId, resultJson, leadTime, submittedAt)
        assigned_tasks.status = ANNOTATED
        tasks.annotation_count += 1
        (annotation_count + 1) >= tasks.overlap → tasks.task_status = COMPLETED
        partnerLabelingEventService.recordTaskSubmitted(...)   ← no-op với user thường
  8. recommendationCacheService.enqueueWatchlist(userId)       ← Redis HSET
                                                             ◄── TX COMMIT
```

**Xử lý lỗi:** toàn bộ block 5-8 nằm trong `try/catch`; catch gọi
`partnerLabelingEventService.recordTaskFailed(...)` rồi **rethrow**.

⚠️ Bước 6 là HTTP call (timeout tối đa 120 s) **bên trong transaction** — DB connection bị giữ
suốt thời gian đó.

---

## Flow 3 — Label Studio Webhook

```
Label Studio ──► POST /internal/webhooks/label-studio   (body: LsWebhookPayload JSON)
      ↓
LsWebhookController.receive(String rawBody)
  objectMapper.readValue(rawBody, LsWebhookPayload.class)   → parse fail = 400
  switch (payload.action):
      PROJECT_CREATED  → syncService.handleProjectCreated(payload.project)
      PROJECT_UPDATED  → syncService.handleProjectUpdated(payload.project)
      PROJECT_DELETED  → syncService.handleProjectDeleted(payload.project.id)
      TASK_CREATED     → syncService.handleTasksCreated(projectId, tasks)
      TASK_DELETED     → syncService.handleTasksDeleted(tasks)
      default          → log.warn "ignored webhook action"
  return 200 OK                                            ◄── TRẢ NGAY, không chờ
      ↓ (thread pool lsSyncExecutor: core 3, max 20, queue 100, CallerRunsPolicy)
SyncServiceImpl.handleProjectCreated  @Async("lsSyncExecutor")
  match = projectTemplateMatcher.resolve(dto.labelConfig)
  projectStatus = MATCHED ? ACTIVE : INACTIVE
  projectRepository.insertIfAbsent(...)        ← native INSERT IGNORE (idempotent)

SyncServiceImpl.handleTasksCreated  @Async
  project = projectRepository.findByLsProjectId(lsProjectId)
      null → log.warn + return                 ← task đến trước project thì bỏ, reconcile sẽ chữa
  taskStatus = project MATCHED ? AVAILABLE : UNAVAILABLE
  for each task: taskRepository.insertIfAbsent(...)

SyncServiceImpl.handleTasksDeleted  @Async
  assignedTaskRepository.cancelActiveByLsTaskIds(ids)   ← HUỶ ASSIGNMENT TRƯỚC
  taskRepository.markLsDeletedByLsIds(ids, now)         ← rồi mới đánh dấu xoá
```

---

## Flow 4 — Reconciliation

```
@Scheduled(cron = "${sync.reconciliation.cron}")   0 */3 * * * *  (3 phút)
ReconciliationJob.run()
  │
  ├── syncService.reconcileProjects()
  │      syncJobLogRepository.save(SyncJobLog.start("SCHEDULED","PROJECT","RECONCILE"))
  │      FETCH:  labelStudioClient.getProjects(page, size=50)  lặp tới hết, sleep 200ms/trang
  │      SAFETY: rỗng → errorMessage "empty list from LS — aborted", return (0,0,0,0)
  │      DIFF:   toInsert = lsIds - dbIds ; toUpdate = ∩ ; toDelete = dbIds - lsIds
  │      APPLY:  insertIfAbsent / updateFromWebhook (+ labelConfigResolver.evictByLsProjectId)
  │              markLsDeletedByLsIds(toDelete)
  │      LOG:    sync_job_log status=SUCCESS + counters
  │      exception → return NGAY (bỏ luôn task reconcile)
  │
  ├── syncService.reconcileTasksForLsDeletedProjects()
  │      cancelActiveByProjectIds + markLsDeletedByProjectIds
  │      exception → log.error, TIẾP TỤC
  │
  └── for lsProjectId in projectRepository.findAllActiveLsIds():
         syncService.reconcileTasksForProject(lsProjectId)
            FETCH:  labelStudioClient.getTasksByProject(...) lặp tới hết
            SAFETY: rỗng + reportedTotal == 0 → tin, xoá local
                    rỗng + reportedTotal khác → ABORT
            DIFF + APPLY (cancelActiveByLsTaskIds TRƯỚC markLsDeletedByLsIds)
         exception 1 project → projectsFailed++, TIẾP TỤC
```

---

## Flow 5 — Assignment Expiry

```
@Scheduled(cron = "${assignment.expiry.cron}")   0 0/10 * * * *
AssignmentExpiryJob.run()
  now = new Date()
  affectedUserIds = assignedTaskRepository.findDistinctUserIdsPendingExpiredBefore(now)
        ← PHẢI đọc trước, sau update sẽ không còn row PENDING nào
  expired = assignedTaskRepository.markExpiredBefore(now)
        UPDATE AssignedTask SET status='EXPIRED'
        WHERE isDeleted=false AND status='PENDING' AND expiredAt < :now
  if expired > 0:
      reverted = taskRepository.revertToAvailableWhereNoPending(now)
        UPDATE tasks SET task_status='AVAILABLE'
        WHERE task_status='IN_PROGRESS' AND alive
          AND NOT EXISTS (assignment PENDING nào)
          AND (COUNT assignment ANNOTATED) < t.overlap
      for userId in affectedUserIds: recommendationCacheService.enqueueWatchlist(userId)
```

---

## Flow 6 — Task Import (Portal, ASYNC)

```
POST /projects/{projectUuid}/task-imports  (multipart)
      ↓ TaskImportController.createImport → TaskImportServiceImpl
  ProjectReadinessValidator / TaskImportFileValidator
  ImportFileStorage.store(...)  → FILE_SERVICE hoặc LOCAL
  INSERT task_import_jobs (status = PENDING, source = PORTAL_UPLOAD, mode = ASYNC)
  → trả jobUuid ngay
      ↓ (≤10 s sau)
@Scheduled(fixedDelay 10s) TaskImportWorkerJob.scan()
  reclaimStaleQueued()          ← job QUEUED quá 15' → re-arm (WAITING nếu có lsImportId, else PENDING)
  jobRepository.findByStatusIn([PENDING, RETRYING, WAITING_LABEL_STUDIO_IMPORT], top 20)
  for each job:
      jobService.claimStatus(jobId, entry, QUEUED)     ← COMPARE-AND-SET, thua thì skip
      processJob(jobId, entry)   → dispatch vào lsSyncExecutor
          LabelConfigDataKeyResolver → data key bắt buộc từ label_config
          TaskImportParserFactory    → parse JSON/CSV/TSV/TXT
          ImportItemPlanner          → ExecutionPlan (tái dùng item cũ khi retry)
          LabelStudioImportClient.importTasks → POST /api/projects/{id}/import
              LS async → status = WAITING_LABEL_STUDIO_IMPORT
                         poll GET /api/projects/{id}/imports/{importId}
                         (interval 3 s, timeout 600 s)
          ImportMirrorExecutor → TaskMirrorServiceImpl → INSERT tasks local
          status = COMPLETED | PARTIAL_FAILED | FAILED_RETRYABLE | FAILED_PERMANENT
      ↓
GET /task-import-jobs/{jobUuid}          → trạng thái + counters
GET /task-import-jobs/{jobUuid}/items    → từng dòng + lỗi
POST /task-import-jobs/{jobUuid}/retry   → status = RETRYING
```

---

## Flow 7 — External Storage Scheduled Import

```
@Scheduled(cron 0 * * * * *)  ExternalStorageSchedulerTick.tick()
  @ConditionalOnProperty task-import.external-storage.enabled = true
  scheduleRepository.findAllEnabled()
  for each schedule:
      fireEvaluator.evaluate(schedule, now)    → FireDecision(shouldFire, reason)
      không đến giờ → log.trace SKIP
      đến giờ:
        run = runService.createRun(schedule, RunTriggerSource.SCHEDULE)
              status SKIPPED_ALREADY_RUNNING / SKIPPED_DISABLED → return
        scanService.scan(schedule, run)
            ExternalStorageProviderRegistry → S3ExternalStorageProvider
                                            | SftpExternalStorageProvider
            credential: EnvBacked... hoặc DbBacked... (AesGcmSecretCipher giải mã)
            list file → phát hiện batch folder → đọc manifest
            ExternalStorageCompatibilityValidator
            INSERT external_import_batches
            ExternalImportJobFactory → INSERT task_import_jobs
                                       (source = EXTERNAL_STORAGE_SCHEDULED, PENDING)
        → TaskImportWorkerJob nhặt lên (Flow 6)
        → ExternalStorageArchiveService move file:
             {root}/{projectUuid}/{yyyy}/{MM}/{dd}/{batchId}/{relative}
```

---

## Flow 8 — Payout: request → paid

```
[USER]  POST /payout-requests
   PayoutRequestServiceImpl.createRequest   @Transactional
     ledgerWriter.lockOrCreateSummary(userId, currency)      ← PESSIMISTIC_WRITE (1)
     re-check available BÊN TRONG khoá
     INSERT payout_requests (status = PENDING)
     ledgerWriter.apply(PAYOUT_RESERVE, key="PAYOUT_RESERVE:<...>")
         available -= amount ; pending += amount
         (available < amount → CompensationException INSUFFICIENT_AVAILABLE)

[ADMIN] POST /admin/payout-requests/{uuid}/start-processing
   PayoutProcessingServiceImpl   @Transactional
     requestRepository.lockByUuid(...)                       ← PESSIMISTIC_WRITE (1) request
     PayoutStateMachine: PENDING → PROCESSING, effect = NONE
     INSERT payout_attempts (IN_PROGRESS)

[ADMIN] POST /admin/payout-requests/{uuid}/mark-paid
     requestRepository.lockByUuid(...)                       ← (1) request
     PayoutStateMachine: PROCESSING → PAID, effect = SETTLEMENT
     ledgerWriter.apply(PAYOUT_SETTLEMENT, key="PAYOUT_SETTLEMENT:<...>")
         lockOrCreateSummary                                 ← (2) summary  [thứ tự cố định]
         pending -= amount ; totalPaid += amount ; available KHÔNG đổi
     payout_attempts → SUCCESS
     notificationEnqueuer → INSERT payout_notifications (PENDING)   ← OUTBOX

[JOB]  @Scheduled(fixedDelay 30s) PayoutNotificationDispatchJob.run()
     dispatcher.reclaimStale()    ← row kẹt SENDING → PENDING
     dispatcher.dispatchBatch()   → NotificationClient → notification-service
                                    (push FCM / mail) → SENT | FAILED | SKIPPED
     RuntimeException bị nuốt có chủ ý — row vẫn nằm trong outbox
```

---

## Flow 9 — Partner SDK

```
Partner backend ──(x-api-key + transactionId)──► API Gateway
Gateway: đổi x-api-key → JWT (auth-service), STRIP Authorization của client
      ↓
IntegrationPartnerFilter.doFilterInternal   (chỉ /integration/**)
  authClient.getUserUUIDFromToken(request)     → ownerUuid = JWT.sub
  partnerService.getByAuthClientOwnerUuid(ownerUuid)
  X-Partner-Code không khớp → 403 PARTNER_CODE_MISMATCH
  PartnerContext.set(partnerId, partnerCode)
  transactionId = TransactionHeaderReader.read(request)
      thiếu → 400 TRANSACTION_ID_REQUIRED
  TransactionContext.set(transactionId)
  finally { PartnerContext.clear(); TransactionContext.clear(); }
      ↓
[1] POST /integration/users/init
      authClient.verifyPermission(..., INTEGRATION_USER_INIT)
      PartnerUserSyncServiceImpl.initUser
        authProfileClient.provisionUser(...)          ← tạo user + profile (BƯỚC 1)
        authProfileClient.provisionUserWithSession()  ← lấy phiên      (BƯỚC 2)
        INSERT partner_user_mappings (externalUserId ↔ questlabUserId)

[2] POST /integration/tasks/request
      authClient.verifyPermission(..., INTEGRATION_TASK_REQUEST)
      PartnerTaskSyncServiceImpl.requestTask
        externalUserId có   → mapping phải tồn tại, else USER_NOT_INITIALIZED
        externalUserId rỗng → pool "__PARTNER_POOL__", lazily provision
        taskDistributionService.assignAnyAvailableTask(questlabUserId)
            taskRepository.findNextAvailableTaskIdOutsideGatedCampaigns(userId)  FOR UPDATE
              JOIN projects (loại task mồ côi)
              overlap slot còn trống
              user chưa nhận task này
              loại campaign có qualification frozen AND required
            INSERT assigned_tasks (PENDING) + tasks → IN_PROGRESS
        logAssignment(... SUCCESS | FAILED ...) → integration_transaction_logs

[3] POST /integration/tasks/{assignedTaskId}/submit
      authClient.verifyPermission(..., INTEGRATION_ANNOTATION_SUBMIT)
      PartnerAnnotationSyncServiceImpl.submitAnnotation → giống Flow 2
```

---

## Flow 10 — Media signed URL

```
[1] App gọi GET /tasks/{taskId}
      TaskServiceImpl.getTaskById
        labelStudioClient.getTaskById(lsTaskId)     ← data gốc, URL trỏ vào LS
        rewriteMediaUrls(contentFromLB, userId)
            mediaSigningService.sign(path, userId):
              expires   = now + label-studio.media-url-ttl-minutes (10')
              signature = HMAC-SHA256(path|userId|expires, media-signing-secret)
              → "/media/{path}?expires={ts}&signature={hex}"

[2] App tải file GET /media/**?expires=..&signature=..   (kèm Authorization)
      CurrentUserFilter → shouldNotFilter (path bắt đầu "/media/") → BỎ QUA
      MediaController.getMedia
        authClient.checkAuthorization(request)
        tokenUserId = authClient.getUserUUIDFromToken(request)
        extractSignedPath(request)      ← cắt theo indexOf("/media/"), KHÔNG cắt theo độ dài
      MediaServiceImpl.getMedia
        mediaSigningService.isValid(path, tokenUserId, expires, signature)
            hết hạn / sai chữ ký / userId khác → 403 "Invalid or expired signed URL"
        HttpURLConnection tới LS, follow tối đa 5 redirect
        header "Authorization: Token <LS token>" CHỈ khi protocol+host+port == LS
            → LS 303 sang S3/MinIO thì token KHÔNG bị gửi kèm
        stream nội dung về client
```
