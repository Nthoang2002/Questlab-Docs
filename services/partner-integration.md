# Domain: Partner Integration (SDK service-to-service)

---

## 1. Purpose

Cho phép **backend của đối tác** (partner) gọi vào Questlab để user của họ làm task gán nhãn,
mà không cần user đó có tài khoản Questlab thật.

Bề mặt này **không dành cho frontend/mobile gọi trực tiếp** — javadoc `IntegrationController`
ghi rõ: *"NOT meant to be called by any frontend/mobile client directly."*

---

## 2. Entry points

### `/integration/**` — partner gọi (S2S)

| Method | Endpoint | Service | Permission code |
|---|---|---|---|
| POST | `/integration/users/init` | `PartnerUserSyncService.initUser` | `INTEGRATION_USER_INIT` |
| POST | `/integration/tasks/request` | `PartnerTaskSyncService.requestTask` | `INTEGRATION_TASK_REQUEST` |
| POST | `/integration/tasks/{assignedTaskId}/submit` | `PartnerAnnotationSyncService.submitAnnotation` | `INTEGRATION_ANNOTATION_SUBMIT` |

Header bắt buộc: `Authorization` (JWT), `transactionId`. Tuỳ chọn: `X-Partner-Code`.

### `/admin/integration/**` — quản trị partner

| Method | Endpoint |
|---|---|
| POST/GET | `/admin/integration/partners` |
| PUT | `/admin/integration/partners/{partnerCode}/auth-client` |
| POST | `/admin/integration/partners/{partnerCode}/api-keys` |
| GET | `/admin/integration/transactions` — tra cứu log đối soát |

---

## 3. Xác thực — mô hình 2 lớp

```
Partner backend
   │  header: x-api-key
   ▼
API Gateway ──────► auth-service : đổi x-api-key thành JWT
   │  header: Authorization: Bearer <JWT>   (gateway STRIP header client gửi lên)
   ▼
questlab-service
   ├── IntegrationPartnerFilter   : AI đang gọi?      → PartnerContext (ThreadLocal)
   └── IntegrationController      : ĐƯỢC PHÉP gì?     → authClient.verifyPermission(...)
```

Chuỗi suy ra partner:

```
JWT.sub  (= base_user.uuid của owner user)
   → auth_client.owner_id → auth_client.id
   → integration_partners.auth_client_id
```

**Phân vai có chủ ý** (javadoc `IntegrationPartnerFilter`):
filter trả lời *ai đang gọi*, controller trả lời *được phép gọi gì*. Tách vậy vì
`ForbiddenException` ném từ controller mới đi qua được `GlobalExceptionHandler`; ở filter thì
phải tự serialize response.

### `transactionId` bắt buộc

Filter **từ chối 400** nếu thiếu header `transactionId`:

> *"Bắt buộc với `/integration/**`: đây là khoá đối soát công nợ với partner. Thiếu mà vẫn cho
> qua thì log ghi `transaction_id = NULL` — hỏng âm thầm đúng cho quan trọng nhất, không ai
> phát hiện cho đến lúc đối số."*

Nó nằm ở **header chứ không phải body** vì luồng App dùng cả endpoint GET (không có body).

### `X-Partner-Code` — cross-check

Nếu client gửi header này mà không khớp partner suy ra từ token → `403 PARTNER_CODE_MISMATCH`.
Mục đích: bắt sớm lỗi cấu hình nhầm key của partner khác.

### `ThreadLocal` phải clear

```java
finally {
  PartnerContext.clear();
  TransactionContext.clear();
}
```
> *"Bắt buộc: `PartnerContext` là ThreadLocal trên thread pool của servlet container. Không
> clear = request của partner sau đọc được context của partner trước."*

### Trust boundary

`resolvePartner` **không kiểm chữ ký JWT** — `AuthClient.extractSub` chỉ Base64-decode payload.
Javadoc thừa nhận thẳng và giải thích: đây là mô hình chung của platform, ranh giới tin cậy là
**gateway**. Hai điều kiện để mô hình này đứng vững (ghi ở
`docs/integration/ADR-001-gateway-trust-boundary.md`):

1. NetworkPolicy chỉ cho gateway tới pod questlab-service;
2. gateway **strip** `Authorization` do client gửi lên.

`JwtVerifier` (HMAC-SHA256, `auth.secret-key`) bổ sung lớp kiểm chữ ký **riêng cho
`/integration/**`**, vì bề mặt này trước đây có phép kiểm mật mã riêng
(`partner_api_keys`, đã bị xoá ở migration `V26__drop_partner_api_keys.sql`).

Giới hạn của `JwtVerifier` được ghi rõ trong javadoc:
- **Không check `iss`** — auth-service truyền `user.getName()` làm issuer (tên hiển thị), check
  vô nghĩa và gãy khi user đổi tên.
- **`exp` là tuỳ chọn** — JWT mint từ api-key dùng `ttl = -1` nên không có `exp`. Chỉ reject
  khi `exp` **có mặt** mà đã quá hạn.
- **HS256 đối xứng** — verify được nghĩa là service này cũng ký được; là bước lùi so với
  RS256/JWKS nhưng vẫn tốt hơn hiện trạng.
- Allowlist thuật toán chỉ 1 giá trị `HS256` → chặn `alg: none` và alg-confusion.
- So sánh chữ ký bằng `MessageDigest.isEqual` (constant-time, tránh timing oracle).
- **Fail closed**: thiếu `auth.secret-key` → từ chối mọi request `/integration/**`.

**Evidence:** `config/integration/IntegrationPartnerFilter.java`, `client/JwtVerifier.java`

---

## 4. Persistence

| Entity | Table | Ý nghĩa |
|---|---|---|
| `IntegrationPartner` | `integration_partners` | partner_code, auth_client_id, status |
| `PartnerUserMapping` | `partner_user_mappings` | `externalUserId` (bên partner) ↔ `questlabUserId` |
| `IntegrationTransactionLog` | `integration_transaction_logs` | log đối soát: partner, event, transaction_id, status |

`IntegrationEventType`: `USER_INIT | USER_CREATED | TASK_ASSIGNED | TASK_SUBMITTED |
TASK_COMPLETED | TASK_FAILED`
`PartnerUserSourceType`: `THIRD_PARTY_APP | PARTNER_APP | SDK_INTEGRATION`

---

## 5. Important flows

### 5.1 Hai chế độ user

```java
if (StringUtils.hasText(request.getExternalUserId())) {
    // ĐỊNH DANH — user phải đã gọi /integration/users/init trước
    return partnerUserMappingRepository.findByPartnerIdAndExternalUserId(...)
        .orElseThrow(() -> new ResourceNotFoundException(..., USER_NOT_INITIALIZED));
}
// VÃNG LAI — dùng chung pool user "__PARTNER_POOL__", lazily provision lần đầu
return partnerUserMappingRepository
    .findByPartnerIdAndExternalUserId(partner.getId(), POOL_EXTERNAL_USER_ID)
    .orElseGet(() -> createPoolUserMapping(partner, request));
```

User pool được tạo thật bên auth-service qua `AuthProfileClient.provisionUser`:
`username = "ql_pool_" + partnerCode`, `email = "ql_pool_{code}@partner.questlab.internal"`.

> ⚠️ Init user phải đi **2 bước**. Javadoc `AuthProfileClient.provisionUser` giải thích:
> DTO của `provision-session` chỉ có `uuid/username/email/first_name/last_name/roles`;
> auth-service **không** bật `FAIL_ON_UNKNOWN_PROPERTIES` nên 10 field profile gửi kèm bị
> Jackson bỏ **im lặng** — user tạo ra không có dòng profile nào, và vì
> `findMemberProfileByUserId` là INNER JOIN nên mọi lần xin task nhận `503
> AUTH_PROFILE_UNAVAILABLE`. Cách đúng: gọi `provisionUser` (tạo user + profile) rồi
> `provisionUserWithSession` (lấy phiên).

### 5.2 Pool task riêng cho partner

Partner **không** đi qua `findNextAssignableTaskId` mà dùng
`TaskDistributionServiceImpl.assignAnyAvailableTask` →
`taskRepository.findNextAvailableTaskIdOutsideGatedCampaigns(userId)`.

Query này **bỏ qua** project/eligibility policy, nhưng **KHÔNG bỏ qua** 4 ràng buộc:

| Ràng buộc | Vì sao (theo javadoc) |
|---|---|
| `JOIN projects` (project còn sống) | `tasks.project_id` không có FK → task mồ côi. Vì `ORDER BY t.id ASC` luôn chọn id nhỏ nhất, nó sẽ vấp đúng dòng hỏng ở **MỌI** lần gọi, **làm chết hẳn luồng partner** cho tới khi ai đó sửa dữ liệu |
| overlap slot còn trống | `task_status` chỉ chuyển `COMPLETED` khi annotation thực sự đủ — khoảng giữa hai mốc là chỗ cấp thừa |
| user chưa nhận task này (`:userId`) | Chế độ vãng lai dùng chung pool user ⇒ người sau mở task ra **thấy nhãn của người trước**. Nặng hơn: `overlap` tồn tại để N người **độc lập** chấm, cùng một danh tính chấm lại thì số liệu đồng thuận là giả |
| loại campaign có qualification `frozen AND required` | SDK partner là kênh tự động, **không có UX để làm bài test** |

Lưu ý: điều kiện loại campaign **cố ý không phụ thuộc user** — task của campaign phải đi qua
luồng campaign chứ không qua pool chung.

**Evidence:** `repository/TaskRepository.java` (javadoc
`findNextAvailableTaskIdOutsideGatedCampaigns`), `service/impl/TaskDistributionServiceImpl.java:227-271`

### 5.3 Ghi log đối soát ở cả 2 nhánh

```java
try {
    assignment = taskDistributionService.assignAnyAvailableTask(mapping.getQuestlabUserId());
} catch (ValidationException e) {
    // hết task là kết quả nghiệp vụ thật, không phải bug (AC2)
    logAssignment(..., IntegrationLogStatus.FAILED, e.getMessage());
    throw e;
}
logAssignment(..., IntegrationLogStatus.SUCCESS, null);
```

### 5.4 `PartnerLabelingEventService` — no-op cho user thường

`AnnotationServiceImpl` gọi `partnerLabelingEventService.recordTaskSubmitted(...)` /
`recordTaskFailed(...)` ở mọi lần submit. Với user thường (không phải user của partner) đây là
**no-op** (comment "AC2"). Nhờ vậy luồng annotation dùng chung một code path cho cả hai loại
user.

---

## 6. Risk

| Rủi ro | Trạng thái |
|---|---|
| `ThreadLocal` rò rỉ giữa request | Đã clear trong `finally` |
| JWT giả mạo | `JwtVerifier` HMAC-SHA256 + trust boundary ở gateway (phụ thuộc NetworkPolicy + gateway strip header — **hạ tầng, không kiểm được trong source**) |
| Thiếu `transactionId` | Reject 400 |
| Nhầm partner | `X-Partner-Code` cross-check → 403 |
| Cùng người chấm lại task mình đã làm | Đã fix bằng `:userId` trong query pool |
| Task mồ côi làm chết luồng | Đã fix bằng `JOIN projects` |
| JWT sống vĩnh viễn (`ttl = -1`) | Bù bằng revoke api-key xoá cache Redis bên auth-service |

---

## 7. Diagram

Xem `partner-integration.d2`.
