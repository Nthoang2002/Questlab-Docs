# Domain: Compensation & Payout (thù lao và trả thưởng)

> Ticket gốc: **RS2-10115** — `docs/RS2-10115 - [Questlab] Luồng thông tin trả thưởng tiền mặt`.
> Đây là domain có **chất lượng kỹ thuật cao nhất** trong codebase (ledger, state machine,
> idempotency, pessimistic locking, outbox). Rất đáng đọc để học.

---

## 1. Purpose

Annotator làm task → được cộng tiền → xin rút → kế toán chi tiền.

Hai nửa:

| Nửa | Nội dung |
|---|---|
| **Compensation** | Sổ cái (ledger) bất biến + bảng tổng hợp số dư |
| **Payout** | Tài khoản nhận tiền, yêu cầu rút, quy trình duyệt/chi của kế toán, thông báo |

---

## 2. Entry points

### User

| Method | Endpoint | Controller |
|---|---|---|
| GET | `/compensation/summary` | `CompensationController` — số dư |
| GET | `/compensation/transactions` , `/transactions/{uuid}` | lịch sử bút toán |
| GET/POST/PUT/PATCH/DELETE | `/payout-accounts/**` | `PayoutAccountController` — tài khoản ngân hàng |
| POST | `/payout-requests` | `PayoutRequestController` — tạo yêu cầu rút |
| GET | `/payout-requests` , `/{uuid}` | xem yêu cầu |
| POST | `/payout-requests/{uuid}/cancel` | xin huỷ |

### Admin / kế toán

| Method | Endpoint | Controller |
|---|---|---|
| GET | `/admin/payout-requests` , `/{uuid}` | `PayoutRequestAdminController` |
| POST | `/admin/payout-requests/{uuid}/start-processing` | `PENDING → PROCESSING` |
| POST | `/admin/payout-requests/{uuid}/mark-paid` | `PROCESSING → PAID` |
| POST | `/admin/payout-requests/{uuid}/mark-failed` | `PROCESSING → PAYMENT_FAILED` |
| POST | `/admin/payout-requests/{uuid}/retry` | `PAYMENT_FAILED → PROCESSING` |
| POST | `/admin/payout-requests/{uuid}/cancel` , `/resolve-cancel` | |
| GET/POST | `/admin/payout-capabilities/**` | `PayoutCapabilityAdminController` — suspend/reactivate user |

---

## 3. Business logic

```
CompensationController      → CompensationQueryServiceImpl        (chỉ đọc)
                            → EarningIngressServiceImpl.recordEarning()   ← điểm ghi earning
                                  ↓
                            CompensationLedgerWriter.apply(LedgerEffect)  ← ĐIỂM GHI DUY NHẤT
                                  ├── UserCompensationSummaryRepository.lockByUserIdAndCurrency (PESSIMISTIC_WRITE)
                                  └── CompensationTransactionRepository.saveAndFlush

PayoutRequestController     → PayoutRequestServiceImpl
PayoutRequestAdminController→ PayoutProcessingServiceImpl
                                  ├── PayoutStateMachine       (luật chuyển trạng thái + hiệu ứng tiền)
                                  ├── CompensationLedgerWriter  (áp hiệu ứng tiền)
                                  ├── PayoutAttemptRepository
                                  └── PayoutNotificationEnqueuer → outbox
PayoutAccountController     → PayoutAccountServiceImpl / PayoutAccountWriter
PayoutCapabilityAdminController → PayoutCapabilityServiceImpl / PayoutCapabilityGuard
```

---

## 4. Persistence

| Entity | Table | Ý nghĩa |
|---|---|---|
| `CompensationTransaction` | `compensation_transactions` | **Sổ cái bất biến**. `idempotency_key` UNIQUE |
| `UserCompensationSummary` | `user_compensation_summaries` | Số dư tổng hợp: `total_earned`, `available_amount`, `pending_amount`, `total_paid`. UNIQUE `(user_id, currency)` |
| `PayoutAccount` | `payout_accounts` | Tài khoản nhận tiền |
| `PayoutRequest` | `payout_requests` | Yêu cầu rút |
| `PayoutAttempt` | `payout_attempts` | Từng lần thử chi tiền |
| `PayoutNotification` | `payout_notifications` | **Outbox** thông báo |
| `UserPayoutCapability` | `user_payout_capabilities` | `ACTIVE | SUSPENDED` |

`CompensationTransactionType`: `EARNING_ACCRUAL | PAYOUT_RESERVE | PAYOUT_RELEASE |
PAYOUT_SETTLEMENT | EARNING_REVERSAL | ADJUSTMENT`

---

## 5. Integration

`PayoutNotificationDispatcher` → `NotificationClient` → **notification-service**
(`POST /api/notifications/push` cho FCM, `POST /api/notifications/send` cho MAIL).

Questlab **không cần biết email của user** — chỉ gọi
`GET /api/notifications/recipients/{userId}` rồi nói "gửi cho user này".

---

## 6. Background processing

| Job | Nhịp | Làm gì |
|---|---|---|
| `PayoutNotificationDispatchJob` | `fixedDelay` `compensation.notification.fixed-delay-ms` = 30 s | `dispatcher.reclaimStale()` + `dispatcher.dispatchBatch()` |

Job này **nuốt `RuntimeException`** một cách có chủ ý:

> *"Nuốt ở đây là đúng: scheduler chỉ cần biết vòng này xong. Row chưa gửi vẫn nằm trong outbox
> nên không có gì bị mất — đó là điểm khác với `@Async`."*

`PayoutNotificationStatus`: `PENDING | SENDING | SENT | FAILED | SKIPPED` —
đúng mẫu **transactional outbox**.

---

## 7. Important flows

### 7.1 Ledger — bất biến được giữ

`CompensationLedgerWriter.apply()` là **điểm ghi duy nhất**. Javadoc liệt kê 4 bất biến:

1. Insert ledger + update summary **trong cùng transaction** — không bao giờ có bút toán đã
   commit mà summary chưa phản ánh.
2. Row summary khoá `PESSIMISTIC_WRITE` **trước khi đọc số dư** → hai luồng cùng user bị
   serialize thay vì lost update.
3. Row summary tạo bằng `INSERT IGNORE` dựa trên `UNIQUE (user_id, currency)` → race "hai
   earning đầu tiên" do DB xử lý.
4. **Không gọi service ngoài trong transaction này.**

Phép toán số dư tập trung ở `applyToSummary`:

| Type | Hiệu ứng |
|---|---|
| `EARNING_ACCRUAL` | `totalEarned += amount`, `available += amount` |
| `PAYOUT_RESERVE` | `available -= amount`, `pending += amount` (fail nếu `available < amount` → `INSUFFICIENT_AVAILABLE`) |
| `PAYOUT_RELEASE` | `pending -= amount`, `available += amount` |
| `PAYOUT_SETTLEMENT` | `pending -= amount`, `totalPaid += amount` — **cố ý không chạm `available`** vì đã trừ từ lúc RESERVE |

### 7.2 Idempotency — mẫu chuẩn để học

```java
// EarningIngressServiceImpl.recordEarning — CỐ Ý KHÔNG @Transactional
1. fast path: findByIdempotencyKey(key)  → có rồi thì trả về luôn, không tốn lock
2. ledgerWriter.apply(effect)            → @Transactional nằm TRONG bean khác
3. catch DataIntegrityViolationException  (UNIQUE idempotency_key bị vi phạm)
     → transaction của luồng thua ĐÃ rollback ⇒ summary KHÔNG bị cộng 2 lần
     → đọc lại bút toán của luồng thắng ở transaction MỚI
4. nếu key đã dùng cho payload KHÁC → 409 IDEMPOTENCY_KEY_CONFLICT (bug ở producer, không nuốt)
```

**Hai chi tiết tinh tế:**

- `recordEarning` **không** có `@Transactional`. Lý do ghi rõ trong javadoc: luồng thua bị
  rollback, muốn đọc lại bút toán của luồng thắng thì **phải đứng ngoài transaction đó**.
- `apply()` dùng `saveAndFlush` chứ không `save`: *"đẩy INSERT xuống DB ngay để vi phạm
  UNIQUE nổ ở đây, thay vì lúc commit khi caller không còn cơ hội xử lý."*

**Evidence:** `service/compensation/impl/EarningIngressServiceImpl.java:30-107`,
`service/compensation/CompensationLedgerWriter.java:21-89`

### 7.3 Payout state machine

`PayoutStateMachine` là class **static, không state** — "nó là luật, không phải service".
Mỗi transition gắn cứng với `MonetaryEffect`:

```
PENDING ──► PROCESSING        (NONE)
PENDING ──► CANCELLED         (RELEASE)

PROCESSING ──► PAID           (SETTLEMENT)
PROCESSING ──► PAYMENT_FAILED (NONE)   ← giữ nguyên reserve!
PROCESSING ──► CANCEL_REQUESTED (NONE)
PROCESSING ──► CANCELLED      (RELEASE)

PAYMENT_FAILED ──► PROCESSING (NONE)   ← retry
...
```

Hai quyết định thiết kế đáng nhớ:

- **`PENDING → PAID` cố ý KHÔNG được phép** — mọi lần chi tiền phải đi qua `PROCESSING` để
  luôn có ít nhất một `PayoutAttempt` và một actor chịu trách nhiệm.
- **`PROCESSING → PAYMENT_FAILED` giữ nguyên reserve** — release ở đây sẽ tạo tình huống
  "tiền đã rời ngân hàng nhưng hệ thống cho user tiêu lại".

Ghép hiệu ứng tiền vào chính transition là để *"không thể chuyển trạng thái mà quên phần tiền"*.

**Evidence:** `service/payout/PayoutStateMachine.java:18-90`

### 7.4 Hình dạng chuẩn của mọi action mutating payout

`PayoutProcessingServiceImpl` bắt mọi action đi cùng một khuôn — javadoc liệt kê 5 bước:

```
1. Khoá row request (PESSIMISTIC_WRITE)     ← điểm serialize
2. Hỏi PayoutStateMachine: transition hợp lệ? hiệu ứng tiền gì?
3. Áp hiệu ứng qua CompensationLedgerWriter  ← cùng transaction với đổi status
4. Mở/đóng PayoutAttempt
5. Ghi audit actor + thời điểm
```

**Thứ tự khoá: request TRƯỚC, summary SAU.** Không đường nào khoá ngược lại
⇒ **không có deadlock**. Đây là điểm hay nhất của thiết kế và là câu hỏi phỏng vấn tốt.

### 7.5 Tạo payout request

```java
@Transactional
createRequest(...):
  UserCompensationSummary summary = ledgerWriter.lockOrCreateSummary(userId, currency);  // khoá TRƯỚC
  // re-check available BÊN TRONG khoá — không được check rồi nhả khoá
  ledgerWriter.apply(LedgerEffect.builder()
      .idempotencyKey("PAYOUT_RESERVE:" + ...)
      .type(PAYOUT_RESERVE) ...);
```

Idempotency key có **namespace prefix**: `PAYOUT_RESERVE:`, `PAYOUT_SETTLEMENT:`,
`PAYOUT_RELEASE:` — để key của các loại bút toán không đụng nhau.

---

## 8. Risk & điểm chưa hoàn thiện

### 8.1 `EarningIngressService` chưa có caller trong source

Grep toàn bộ `src/main/java`: `EarningIngressService` **chỉ xuất hiện trong chính package
compensation** (interface, impl, và 1 javadoc của `PayoutCapabilityGuard`).

⇒ **Không tìm thấy nơi nào gọi `recordEarning` khi user submit annotation.**
`AnnotationServiceImpl` không inject nó. Nghĩa là ở thời điểm đọc source, hạ tầng ledger đã
sẵn sàng nhưng **đường nối "làm task → được cộng tiền" chưa được đấu**.

Đây là kết luận từ evidence:
```
grep -rn "EarningIngressService" src/main/java
  → chỉ 5 hit, toàn bộ trong service/compensation/**
```
**Chưa đủ evidence trong source để kết luận** earning được ghi bằng cách nào khác
(qua job? qua API admin?). Cần hỏi team.

### 8.2 Các rủi ro khác

| Rủi ro | Cách xử lý |
|---|---|
| Lost update số dư | `PESSIMISTIC_WRITE` trên `user_compensation_summaries` |
| Deadlock | Thứ tự khoá cố định: request → summary |
| Ghi tiền 2 lần | `UNIQUE(idempotency_key)` + retry đọc lại |
| Chi tiền rồi user tiêu lại | `PAYMENT_FAILED` giữ nguyên reserve |
| Notification gửi 2 lần / mất | Outbox `payout_notifications` + `reclaimStale()` |
| User bị khoá vẫn rút được | `PayoutCapabilityGuard` (suspend **không** chặn earning mới, chỉ chặn rút) |

---

## 9. Diagram

Xem `compensation-payout.d2`.
