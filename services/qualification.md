# Domain: Qualification & Question Bank

> Ticket gốc: **RS2-10027** (được nhắc trong `application.yml` và javadoc).

---

## 1. Purpose

Một campaign có thể yêu cầu annotator **thi đậu bài kiểm tra** trước khi được nhận task thật.
Domain này gồm 2 nửa:

| Nửa | Trả lời câu hỏi |
|---|---|
| **Question Bank** (`/questions`, `/question-sets`) | Ngân hàng câu hỏi & bộ đề dùng chung cho toàn hệ thống |
| **Qualification** (`/campaigns/{id}/qualification`, `/qualification/**`) | Cấu hình bài test của campaign, chấm bài, giữ kết quả PASS/FAIL |

Ngoài ra, Question Set còn được project `SURVEY` dùng làm nội dung
(`projects.question_set_id`).

---

## 2. Entry points

### Question Bank

| Method | Endpoint | Controller |
|---|---|---|
| POST/GET/PUT/DELETE | `/questions`, `/questions/{id}` | `QuestionController` |
| PATCH | `/questions/{id}/publish` \| `/deactivate` | `QuestionController` |
| POST/GET/PUT/DELETE | `/question-sets`, `/question-sets/{id}` | `QuestionSetController` |
| PATCH | `/question-sets/{id}/publish` \| `/deactivate` | `QuestionSetController` |
| POST/PUT/DELETE | `/question-sets/{id}/questions`, `/questions/order`, `/questions/{qid}/settings` | `QuestionSetController` |

### Qualification — cấu hình (admin)

| Method | Endpoint | Controller |
|---|---|---|
| GET/PUT | `/campaigns/{campaignId}/qualification` | `CampaignQualificationController` |
| GET | `/campaigns/{campaignId}/qualification/readiness` | `CampaignQualificationController` |
| POST | `/qualification/questions` | `QualificationQuestionController` — "prepare" định nghĩa câu hỏi |
| PUT | `/qualification/questions/{id}/grading` | cấu hình cách chấm |
| POST/GET | `/qualification/questions/{id}/reviews` | quy trình duyệt câu hỏi |

### Qualification — thi (user)

| Method | Endpoint | Controller |
|---|---|---|
| POST | `/campaigns/{campaignId}/qualification/attempts` | `CampaignQualificationAttemptController.startAttempt` |
| GET | `/campaigns/{campaignId}/qualification/status` | trạng thái của tôi |
| GET | `/qualification/attempts/{attemptId}` | `QualificationAttemptController` |
| PUT | `/qualification/attempts/{attemptId}/answers/{attemptQuestionId}` | lưu từng câu (autosave) |
| POST | `/qualification/attempts/{attemptId}/submit` | nộp bài + chấm |
| GET | `/qualification/attempts/{attemptId}/result` | xem kết quả |

---

## 3. Business logic

```
CampaignQualificationController → CampaignQualificationServiceImpl   (config, freeze)
QualificationQuestionController → QualificationQuestionServiceImpl   (định nghĩa + grading)
                                → QualificationReviewServiceImpl     (duyệt 2 reviewer)
                                → QualificationReadinessServiceImpl  (campaign đã sẵn sàng chưa)
QualificationAttemptController  → QualificationAttemptServiceImpl
                                     ├── QualificationAttemptStarter   (tạo attempt + bốc đề)
                                     ├── AttemptQuestionSelector        (chọn câu theo set rule)
                                     ├── AnswerShapeValidator / AttemptAnswerCodec
                                     └── AttemptGrader                  (chấm)
QualificationPoolServiceImpl    → freezeForGoLive(campaign)   ← gọi từ CampaignServiceImpl
QualificationAssignmentGate     → dùng bởi TaskDistributionServiceImpl + RecommendedTaskAssignmentServiceImpl
```

---

## 4. Persistence

| Entity | Table | Ý nghĩa |
|---|---|---|
| `Question` / `QuestionOption` | `questions` / `question_options` | ngân hàng câu hỏi |
| `QuestionSet` / `QuestionSetItem` | `question_sets` / `question_set_items` | bộ đề |
| `QualificationQuestionDefinition` | `qualification_question_definitions` | câu hỏi đã gắn đáp án + cách chấm, có `verification_status` |
| `QualificationQuestionReview` | `qualification_question_reviews` | mỗi lượt duyệt của reviewer |
| `CampaignQualificationConfig` | `campaign_qualification_configs` | cấu hình test của campaign, có `version`, **`frozen`**, `required` |
| `CampaignQualificationSetRule` | `campaign_qualification_set_rules` | rule bốc bao nhiêu câu từ set nào |
| `CampaignQualificationPoolItem` | `campaign_qualification_pool_items` | pool đã freeze |
| `QualificationAttempt` | `qualification_attempts` | 1 lượt thi |
| `QualificationAttemptQuestion` | `qualification_attempt_questions` | snapshot đề của lượt thi đó |
| `QualificationAttemptAnswer` | `qualification_attempt_answers` | câu trả lời |

### Enum quan trọng

- `QualificationVerificationStatus`: `DRAFT | PENDING_REVIEW | VERIFIED | REJECTED`
- `QualificationAttemptStatus`: `IN_PROGRESS | PASSED | FAILED | EXPIRED | CANCELLED`
- `GradingMode`: `EXACT_SINGLE | EXACT_SET | ACCEPTED_TEXT | AUTO_PASS_ON_VALID_INPUT`
- `AnswerResultCode`: `CORRECT | INCORRECT | MISSING | INVALID_FORMAT | AUTO_PASS`
- `QualificationMetricType`: `GOLD_ACCURACY | COHEN_KAPPA | ...`

---

## 5. Integration

Không gọi hệ thống ngoài. Domain thuần nội bộ Questlab.

---

## 6. Background processing

| Job | Cron | Làm gì |
|---|---|---|
| `QualificationAttemptExpiryJob` | `qualification.attempt.expiry-cron` = `0 */5 * * * *` | Đóng attempt (a) quá `expires_at`, (b) campaign đã rời `ACTIVE` |

Job này dùng `HashSet<Long> seen` để **khử trùng**: một attempt có thể vừa quá hạn vừa mồ côi,
xử lý 2 lần sẽ ghi row 2 lần và log 2 lần.

Javadoc nói rõ vì sao job này bắt buộc phải có: *"Only one attempt per candidate may be open at
a time, so an abandoned one blocks them from ever starting again (D7)."* — attempt bỏ dở mà
không hết hạn sẽ **khoá vĩnh viễn** quyền thi lại của user.

Đồng thời, user quay lại trước khi job chạy **không phải chờ**: service tự đóng attempt quá hạn
ngay tại chỗ.

**Evidence:** `job/QualificationAttemptExpiryJob.java:44-84`

---

## 7. Important flows

### 7.1 Freeze — vì sao PASS có thể "mất giá trị"

```
Admin sửa cấu hình test    →  tạo CampaignQualificationConfig version mới (frozen = false)
Admin approve/activate campaign →  QualificationPoolService.freezeForGoLive()
                                     → chốt pool item, set frozen = TRUE
```

`QualificationAssignmentGate.blockedByCampaign` đọc **config `frozen` mới nhất**, không phải
version mới nhất:

```java
Optional<CampaignQualificationConfig> frozen = configRepository
    .findFirstByCampaignIdAndFrozenTrueAndIsDeletedFalseOrderByVersionDesc(campaignId);
if (frozen.isEmpty() || !frozen.get().isRequired()) return false;   // cho qua
boolean passed = attemptRepository.existsByQualificationConfigIdAndUserIdAndStatusAndIsDeletedFalse(
        config.getId(), userId, PASSED);
return !passed;
```

⇒ PASS gắn với **một `qualificationConfigId` cụ thể**. Admin freeze version mới ⇒ PASS cũ
không còn khớp ⇒ user phải thi lại (§3.2.13).

### 7.2 Gate — 3 nhánh cho qua

`QualificationAssignmentGate` (dùng trong `requestTask`) cho qua khi:

1. project không thuộc `ACTIVE` campaign nào;
2. campaign chưa có config `frozen`;
3. config `frozen` hiện hành có `required = false`.

Hai API dùng gate theo 2 kiểu khác nhau:

| Nơi gọi | Method | Hành vi |
|---|---|---|
| `requestTask` (quét nhiều project) | `blockedProjectIds(userId, ids)` | **loại khỏi candidate**, không throw |
| `directAssign`, recommendation-assign (đã chọn đúng 1 task) | `requirePassed(userId, projectId)` | **throw** `BadRequestException(QUALIFICATION_REQUIRED)` để user biết đi thi |

`blockedProjectIds` tối ưu: cache kết quả theo `campaignId` bằng `computeIfAbsent`, nên số query
là **O(số campaign)** chứ không phải O(số project).

**Evidence:** `service/qualification/QualificationAssignmentGate.java:56-141`

### 7.3 Submit attempt — chống chấm 2 lần

```java
@Transactional
public QualificationAttemptResultResponse submit(UUID attemptId, UUID userId) {
  QualificationAttempt attempt = attemptRepository.lockByUuid(attemptId)   // PESSIMISTIC_WRITE
      ...
```

Javadoc của `lockByUuid`: *"Submitting twice — a retried request after a timeout — must not
score twice (§22.2). The lock serialises the two calls so the second one sees the terminal state
and returns the stored result."*

Đây là **idempotency bằng pessimistic lock + terminal-state check** — mẫu đáng nhớ.

**Evidence:** `repository/qualification/QualificationAttemptRepository.java:20-29`,
`service/qualification/impl/QualificationAttemptServiceImpl.java:226-230`

### 7.4 `startAttempt` cố ý KHÔNG `@Transactional`

Javadoc: *"Deliberately not `@Transactional`: the write runs in the starter's own [transaction]"*
— tách boundary để `QualificationAttemptStarter` tự quản lý.

### 7.5 Duyệt câu hỏi — 2 reviewer

`qualification.review.required-approvals: 2` — definition chỉ thành `VERIFIED` khi có **2
reviewer KHÁC NHAU** APPROVE.

⚠️ Comment trong `application.yml` cảnh báo:
*"`[SECURITY REVIEW REQUIRED]` chỉ có ý nghĩa thật khi ops tạo role reviewer riêng và gán ≥2
người — hiện mọi migration mới seed `sys_admin` (D1)."*

### 7.6 Readiness — campaign đủ điều kiện approve chưa

`QualificationReadinessService` trả về danh sách `QualificationReadinessIssue`:
`QUALIFICATION_NOT_CONFIGURED`, `NO_QUESTION_SET_LINKED`, `TOTAL_VERIFIED_POOL_TOO_SMALL`,
`METRIC_NOT_SUPPORTED`, `QUALIFICATION_SETS_OVERLAP`, `INSUFFICIENT_VERIFIED_QUESTIONS`,
`SET_NOT_USABLE`, `SOURCE_INTEGRITY_ERROR`.

`qualification.min-verified-pool-size: 30` — chặn đề thi ít câu tới mức học thuộc được.

---

## 8. Risk

- **Attempt bỏ dở khoá quyền thi lại** — đã có `QualificationAttemptExpiryJob` + auto-close
  tại chỗ. Nếu job chết, user bị kẹt.
- **Retry policy**: `qualification.retry.default-max-attempts: 3`,
  `default-cooldown-minutes: 1440`. Lưu ý API: gửi `retryPolicy` với `maxAttempts = null` nghĩa
  là **KHÔNG giới hạn**, khác với **không gửi** `retryPolicy` (dùng default). Đây là bẫy API
  được ghi rõ trong `application.yml` §12.2.
- **`attempt_ttl_minutes` = 120 là đề xuất, product chưa chốt** (`[VERIFY]` trong config).
- Cấu hình theo thứ tự: cột trong `campaign_qualification_configs` (NULL = kế thừa) →
  `application.yml`. Đổi ở yml là campaign chưa pin giá trị riêng nhận ngay, không cần migration.

---

## 9. Diagram

Xem `qualification.d2`.
