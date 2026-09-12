# Domain: Task Recommendation ("Dành cho bạn") — và Redis

> Requirement gốc: `docs/REQUIREMENT-HOME-RECOMMENDED-TASKS.md`.
> **Đây là domain DUY NHẤT dùng Redis trong questlab-service.**

---

## 1. Purpose

Màn hình Home của app hiển thị vài task gợi ý sẵn cho user, thay vì bắt bấm "xin task" rồi
chờ. Chạy lại toàn bộ eligibility + policy + SQL chọn task ở **mỗi lần mở app** là quá đắt →
kết quả được cache trong Redis, và một job nền refill trước.

---

## 2. Entry points

| Method | Endpoint | Controller | Mục đích |
|---|---|---|---|
| GET | `/assignments/recommendations` | `TaskRecommendationController.getRecommendations` | Lấy danh sách gợi ý (đọc cache, miss thì build) |
| POST | `/assignments/recommendations/{recommendationId}/assign` | `TaskRecommendationController.assignRecommendation` | Bấm nhận → revalidate + lock + tạo assignment |

---

## 3. Business logic

```
TaskRecommendationController
    ├── TaskRecommendationServiceImpl          (đọc/ghi cache, build response)
    │      ├── TaskRecommendationCacheServiceImpl   ← Redis
    │      ├── TaskRecommendationCandidateServiceImpl
    │      │       └── TaskRepository.findRecommendableTaskIds  (KHÔNG lock)
    │      └── TaskRecommendationMapper
    └── RecommendedTaskAssignmentServiceImpl   (nhận task)
           └── TaskRepository.lockRecommendedTaskForUser  (CÓ FOR UPDATE)
```

---

## 4. Redis — dùng cho việc gì

`CacheServiceConfig` tạo bean `CacheRedisService` (từ thư viện `com.ttt.base:cache`) bọc
`RedisTemplate<Object,Object>`. **Không** dùng `@Cacheable`/`@CacheEvict` của Spring, **không**
dùng Redisson, **không** dùng distributed lock.

| Key | Kiểu | TTL | Nội dung |
|---|---|---|---|
| `questlab:recommendations:user:{userId}` | String (JSON) | `recommendations.cache.ttl-seconds` = 600s | `UserRecommendationCache` — envelope chứa `items[]` |
| `questlab:recommendations:id:{recommendationId}` | String (JSON) | 600s | `RecommendationLookup` — để resolve khi user bấm nhận |
| `questlab:recommendations:watchlist` | **Hash** (`userId` → `"1"`) | không TTL | Hàng đợi user cần refill |

**Evidence:** `assignment/recommendation/RecommendationCacheKeys.java`

### Vì sao watchlist là Hash mà không phải List/Set?

Javadoc `TaskRecommendationCacheServiceImpl`:

> *"Stores the watchlist as a Redis Hash keyed by user UUID so each user appears at most once
> between drains."*
> *"The ttt interface does not expose atomic SETNX or Redis SET operations"* — thư viện
> `CacheRedisService` chỉ có `setValue/getValue/remove/hSet/hKeys/hDel`, nên Hash là cách khử
> trùng khả dụng.

### Không có lock rebuild — có chủ ý

> *"Skips per-user / per-job rebuild locks — the worst case is a duplicate cache build, which is
> benign (the last write wins and concurrent requests still get a valid response)."*

### Redis chết thì sao?

Mọi thao tác Redis đều bọc `try/catch (DataAccessException)` và log `REDIS_DOWN`:

```java
private String readStringSafe(String key) {
  try { ... } catch (DataAccessException ex) {
    log.warn("[readStringSafe] REDIS_DOWN key={}, msg={}", key, ex.getMessage());
    return null;                     // coi như cache miss
  }
}
```

⇒ **Redis down = degrade, không phải chết**. Recommendation rơi về build trực tiếp từ SQL.
`POST /assignments/request` (luồng xin task chính) **không đụng Redis** nên không bị ảnh hưởng.

### Schema versioning

`UserRecommendationCache.CURRENT_SCHEMA_VERSION`. Đọc ra mà version khác → **evict + coi như
miss**. Nhờ vậy deploy đổi cấu trúc cache không cần flush Redis thủ công.

---

## 5. Background processing

| Job | Cron | Làm gì |
|---|---|---|
| `TaskRecommendationRefillJob` | `recommendations.refill.cron` = `0 */5 * * * *` | `popWatchlistBatch(batch-size=100)` → với mỗi user: `candidateService.build(...)` → `writeUserCache(...)` |

Xử lý lỗi trong job:

```java
catch (AuthProfileUnavailableException ex) {
    cacheService.enqueueWatchlist(userId);       // re-enqueue để lần sau thử lại
    // hash dedup tạo ra backoff tự nhiên
}
catch (Exception ex) {
    // đếm otherFailures, KHÔNG re-enqueue
}
```

Pool rỗng **không** re-enqueue: *"Empty pool is a legitimate outcome — don't keep retrying
immediately."*

### Ai đẩy user vào watchlist?

| Nơi | Khi nào |
|---|---|
| `AnnotationServiceImpl.createAnnotation` | user vừa submit → slot đã dùng, cache cũ sai |
| `AssignmentExpiryJob` | assignment hết hạn → có slot mới |
| `RecommendedTaskAssignmentServiceImpl.assign` | nhận task thành công |
| `TaskRecommendationServiceImpl` | cache miss / stale |

---

## 6. Important flows

### 6.1 GET recommendations

```
GET /assignments/recommendations
    ↓ TaskRecommendationServiceImpl
    1. cacheService.readUserCache(userId)
         HIT  → validate lại tính "còn dùng được" của từng item, trả về (max recommendations.response.max-items = 5)
         MISS → enqueueWatchlist(userId)
                candidateService.build(userId, pool-size=20, ttl=600)
                writeUserCache(envelope)   ← ghi cả envelope lẫn từng lookup key
```

`candidate.pool-size: 20` nhưng `response.max-items: 5` — build dư 20 để khi vài item bị "ôi"
vẫn còn đủ 5 cái trả về mà không phải query lại.

Query dùng: `TaskRepository.findRecommendableTaskIds` — **cùng predicate với
`findNextAssignableTaskId`** (status, alive, overlap slot, dedup, `max_overlap_ratio`) nhưng
trả nhiều dòng và **KHÔNG có `FOR UPDATE`**, vì đây là đường read-only.

### 6.2 POST assign recommendation — 5 bước

```
1. cacheService.readLookup(recommendationId)
      empty → RECOMMENDATION_NOT_FOUND (kết quả "stale" bình thường, không phải lỗi)
2. ownership check: lookup.userId == userId ?
      không khớp → trả NOT_FOUND (KHÔNG trả FORBIDDEN — tránh lộ sự tồn tại của id user khác)
3. expiry check: lookup.expiresAt < now → deleteLookup + RECOMMENDATION_EXPIRED
4. revalidateAndAssign(userId, lookup):
      - quota check
      - lấy profile + build context   (AuthProfileUnavailableException → 503 mềm)
      - findEligibleProjects tại thời điểm CLICK (policy có thể đã đổi từ lúc build cache)
      - qualification gate
      - taskRepository.lockRecommendedTaskForUser(userId, projectId, taskId)  ← FOR UPDATE
            empty → RECOMMENDATION_TASK_NOT_ASSIGNABLE (ai đó đã lấy mất)
      - tạo AssignedTask PENDING + updateTaskStatus
5. thành công → evictUserCache + enqueueWatchlist
   stale có mã biết trước → deleteLookup (retry cùng id sẽ nhanh)
```

**Điểm thiết kế quan trọng:** cache **chỉ là gợi ý**, không phải quyền. Mọi điều kiện được
**revalidate tại thời điểm click**, và lock đặt ở đó chứ không ở lúc build cache.

**Evidence:** `service/impl/RecommendedTaskAssignmentServiceImpl.java:68-160`,
`repository/TaskRepository.java:256-332`

---

## 7. Risk

| Rủi ro | Xử lý |
|---|---|
| Cache stale → user bấm vào task đã bị người khác lấy | `lockRecommendedTaskForUser` trả empty → `RECOMMENDATION_TASK_NOT_ASSIGNABLE`, FE hiển thị "task không còn" |
| User A dùng recommendationId của user B | Ownership check, trả `NOT_FOUND` để không lộ thông tin |
| Redis down | Mọi op bọc `DataAccessException` → degrade sang SQL |
| Cache schema đổi khi deploy | `schemaVersion` mismatch → evict |
| Watchlist phình to | Hash dedup + `popWatchlistBatch` xoá field khi lấy ra |
| Duplicate cache build | Chấp nhận (benign, last-write-wins) |
| **`@Transactional protected revalidateAndAssign` bị self-invocation** | Annotation **không có hiệu lực** (Spring proxy không chặn self-call). An toàn nhờ `FOR UPDATE` trong query, nhưng là điểm cần biết |

---

## 8. Diagram

Xem `recommendation.d2`.
