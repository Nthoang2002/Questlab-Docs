# Questlab Backend Overview

> **Tài liệu onboarding cho Backend Developer ~2 năm kinh nghiệm.**
> Toàn bộ nội dung dưới đây được kiểm chứng bằng cách đọc source, không suy luận từ README.
> Đường dẫn file được ghi ở mục **Evidence** của từng kết luận quan trọng.
> Đường dẫn tương đối với `questlab-service/` trừ khi ghi rõ khác.
>
> Kiến trúc tổng: [`questlab-architecture.d2`](./questlab-architecture.d2)
> Chi tiết domain: [`../services/`](../services/) · Chi tiết flow: [`../flows/`](../flows/)

---

## 1. Project Overview

### Questlab giải quyết bài toán gì?

Questlab là **nền tảng crowdsourcing gán nhãn dữ liệu (data labeling)**.

Bài toán thực tế: một công ty AI cần 100 000 bức ảnh được gán nhãn. Họ có
**Label Studio** — công cụ mã nguồn mở để annotator ngồi vẽ box/chọn nhãn. Nhưng Label Studio
chỉ phục vụ một đội annotator nội bộ nhỏ; nó **không** biết cách:

- điều phối hàng nghìn người dùng ngoài (crowd) tự nhận việc;
- đảm bảo mỗi task được N người **khác nhau** làm độc lập (overlap) để đo đồng thuận;
- chặn người không đủ trình độ, bắt thi sát hạch trước;
- tính tiền công và trả thưởng;
- mở API cho đối tác đưa người dùng của họ vào làm.

**Questlab là lớp điều phối đó**, đặt phía trước Label Studio.

### Mô hình khái niệm

```
Campaign  (chiến dịch, có thời hạn + phần thưởng + bài thi sát hạch)
   │ N-N
   ▼
Project   (1 lô việc — mirror 1 project bên Label Studio)
   │ 1-N
   ▼
Task      (1 đơn vị dữ liệu cần gán nhãn, có overlap = cần N người)
   │ 1-N
   ▼
AssignedTask   (1 lượt giao task cho 1 user, có hạn 3 ngày)
   │ 1-1
   ▼
TaskAnnotation (kết quả gán nhãn — mirror của annotation bên Label Studio)
   │
   ▼
CompensationTransaction (bút toán tiền công)  →  PayoutRequest (yêu cầu rút)
```

### Workspace gồm 4 repo

| Repo | Vai trò | Ghi chú |
|---|---|---|
| **`questlab-service`** | **Backend chính — tài liệu này nói về nó** | 702 file Java, 107 file test |
| `auth-service` | Xác thực, JWT HS256, user/member profile, permission, api-key partner | Spring Boot cũ hơn, jjwt 0.9.1, Keycloak admin client |
| `notification-service` | Gửi push (FCM) / mail; nhận HTTP rồi đẩy **Kafka** nội bộ | Kafka nằm ở **đây**, không phải ở questlab |
| `admin-portal` | Frontend Angular cho admin | |

**Evidence:** `pom.xml` của 4 repo; `notification-service/src/main/java/com/ttt/notification/kafka/NotificationConsumer.java`

---

## 2. Backend Responsibility

`questlab-service` chịu trách nhiệm:

| # | Trách nhiệm | Nơi thực hiện |
|---|---|---|
| 1 | **Mirror** project/task/annotation từ Label Studio và giữ đồng bộ 2 chiều | `SyncServiceImpl`, `LsWebhookController`, `ReconciliationJob` |
| 2 | **Phân phối task** cho annotator, đảm bảo overlap + không trùng người + không race | `TaskDistributionServiceImpl`, `TaskRepository` (FOR UPDATE) |
| 3 | **Đánh giá điều kiện** (policy theo profile) trước khi giao việc | `ProjectEligibilityServiceImpl`, `AssignmentPolicyEvaluatorImpl` |
| 4 | **Sát hạch** — bài test đầu vào theo campaign | package `service/qualification/**` |
| 5 | **Validate annotation** theo `label_config` XML của project | `AnnotationValidationOrchestrator`, package `validation/**` |
| 6 | **Nhập dữ liệu** từ Portal / SFTP / S3 / MinIO thành task | package `service/taskimport/**` |
| 7 | **Sổ cái tiền công + quy trình trả thưởng** | package `service/compensation/**`, `service/payout/**` |
| 8 | **Cổng tích hợp partner** (SDK service-to-service) | package `service/integration/**` |
| 9 | **Proxy media** của Label Studio bằng signed URL | `MediaServiceImpl`, `MediaSigningServiceImpl` |
| 10 | **Gợi ý task** cho màn hình Home (Redis cache) | `TaskRecommendationServiceImpl` |

`questlab-service` **KHÔNG** chịu trách nhiệm: phát hành JWT (auth-service), gửi
push/mail (notification-service), lưu file gốc (file-service / LS storage), giao diện gán nhãn
(Label Studio).

---

## 3. Technology Stack

| Technology | Version | Purpose | Evidence |
|---|---|---|---|
| **Java** | 17 | ngôn ngữ | `pom.xml` `maven.compiler.source` |
| **Spring Boot** | **3.3.2** | framework | parent `com.ttt.core:base:1.0.0` → `spring-boot-starter-parent:3.3.2` |
| **Spring Cloud** | 2023.0.3 | Config Server + Eureka client | parent pom |
| **Maven** | wrapper `mvnw` | build | `pom.xml`, `.mvn/` |
| **MariaDB** | driver 2.5.4 | database `questlab_data` | `application.yml` `spring.datasource` |
| **Spring Data JPA / Hibernate** | Boot-managed | ORM, `ddl-auto: none` | `application.yml` |
| **Redis** | qua `com.ttt.base:cache` | **chỉ** cache Home-recommendation | `CacheServiceConfig`, `TaskRecommendationCacheServiceImpl` |
| **RestTemplate + Apache HttpClient5** | Boot-managed | mọi outbound HTTP | `config/RestTemplateConfig.java` |
| **Lombok** | 1.18.30 | boilerplate (`@FieldDefaults`, `@RequiredArgsConstructor`) | `pom.xml` |
| **MapStruct** | 1.5.5.Final | mapper entity↔DTO | `pom.xml`, package `mapper/` |
| **ModelMapper** | 2.4.4 | mapper (song song MapStruct) | `pom.xml` |
| **springdoc-openapi** | 2.5.0 | Swagger UI `/swagger-ui` | `pom.xml`, `config/SwaggerConfig.java` |
| **AWS SDK v2 (S3)** | 2.28.20 | provider S3 + MinIO (path-style) | `pom.xml`, `S3ExternalStorageProvider` |
| **Apache Mina SSHD** | 2.13.2 | provider SFTP | `pom.xml`, `SftpExternalStorageProvider` |
| **com.ttt.core:common / lib** | 0.1.2 | `GetMethodResponse`, `BaseMethodResponse`, exception chung, `EncodeUtils` | `pom.xml` |
| **Spring Boot Admin client** | 3.3.3 | monitoring | parent pom, `application.yml` |
| **Logback** | Boot-managed | logging | `logback-spring.xml` |

### KHÔNG có trong questlab-service

Đã grep toàn bộ `src/main/java` và `src/main/resources`:

```
Kafka / RabbitMQ   → 0 hit (chỉ 1 comment nhắc notification-service dùng Kafka)
@FeignClient       → 0 hit
Spring Security    → 0 hit (không có SecurityConfig, không có @PreAuthorize)
Flyway / Liquibase → 0 hit (migration SQL chạy tay)
Redisson / ShedLock→ 0 hit
Quartz             → 0 hit (dùng @Scheduled của Spring)
```

---

## 4. High-Level Architecture

📐 **File D2:** [`questlab-architecture.d2`](./questlab-architecture.d2) — mở trên
<https://play.d2lang.com/>.

### Giải thích bằng lời

Có **4 tầng** đọc từ ngoài vào:

**Tầng 1 — External Actors.** Ba loại client: app mobile của annotator, admin-portal (Angular),
và backend của partner. Tất cả đi qua **API Gateway**. Gateway làm hai việc quan trọng: đổi
`x-api-key` của partner thành JWT (bằng cách gọi auth-service), và **strip** header
`Authorization` mà client tự gửi lên. Điều thứ hai là nền tảng của toàn bộ mô hình bảo mật —
xem §16.

**Tầng 2 — Application (`questlab-service`).** Một Spring Boot monolith, port 9090. Bên trong
là kiến trúc phân lớp cổ điển:

```
Filter (CurrentUserFilter, IntegrationPartnerFilter)
   ↓
Controller  (~171 endpoint)
   ↓
Service     (~55 @Service, interface + Impl)
   ↓
Repository  (47 Spring Data JPA repository)
   ↓
MariaDB
```

Song song với đường HTTP còn hai đường vào khác:
- **Scheduler** — 9 job `@Scheduled` gọi thẳng vào tầng Service/Repository.
- **Webhook** — Label Studio đẩy event vào `LsWebhookController`.

Và một tầng ra: **Integration Layer** — mọi outbound HTTP đi qua đây
(`LabelStudioClient`, `AuthProfileClient`, `NotificationClient`, `FileServiceApiImplClient`,
các `ExternalStorageProvider`).

**Tầng 3 — Infrastructure.** MariaDB là nơi lưu mọi thứ. Redis chỉ phục vụ **một** tính năng
(Home recommendation) và **có thể chết mà hệ thống vẫn chạy**. Config Server nạp cấu hình lúc
bootstrap; Eureka và Spring Boot Admin phục vụ vận hành.

**Tầng 4 — External Systems.** Label Studio là hệ thống quan trọng nhất — nó vừa là *nguồn dữ
liệu* (project, task, annotation) vừa là *đích ghi* (khi user submit annotation). auth-service,
notification-service, file-service là các microservice cùng nền tảng. S3/MinIO/SFTP là nguồn dữ
liệu thô cho module Task Import.

---

## 5. Project Structure

```
questlab-service/
├── pom.xml
├── Dockerfile
├── .gitlab-ci.yml
├── CLAUDE.md                     ← team knowledge base (đọc trước khi code)
├── conventions/                  ← CODING_CONVENTIONS, PROJECT_ARCHITECTURE, TEAM_GUIDE,
│                                    SIGNED_URL_DESIGN, TASK_DISTRIBUTION_DESIGN
├── requirement/                  ← TASK_ASSIGNMENT_REQURIREMENT.MD
├── docs/                         ← requirement chi tiết từng feature (đọc khi nhận ticket)
├── tools/graphify/               ← script sinh graph quan hệ code (out/graph.html)
└── src/main/
    ├── resources/
    │   ├── application.yml       ← toàn bộ config nghiệp vụ (cron, ngưỡng, giới hạn)
    │   ├── bootstrap.yml         ← spring.application.name + CONFIG_SERVER_URI
    │   ├── logback-spring.xml
    │   └── db/migration/         ← 37 file SQL, V2..V37 (chạy TAY, không có Flyway)
    └── java/com/ttt/questlab/
        ├── QuestlabApplication.java      ← @SpringBootApplication @EnableScheduling
        │
        ├── controller/                   ← REST API
        │   ├── docs/                     ← hằng số mô tả Swagger (tách khỏi controller)
        │   ├── integration/              ← IntegrationController, PartnerAdminController
        │   └── taskimport/external/      ← ExternalStorageController, ExternalAssetController
        ├── webhook/                      ← LsWebhookController
        │
        ├── service/                      ← interface ở gốc, Impl ở service/impl
        │   ├── impl/                     ← 24 Impl "core"
        │   ├── compensation/  payout/    ← tiền
        │   ├── qualification/            ← sát hạch (+ grading/, model/)
        │   ├── question/                 ← ngân hàng câu hỏi
        │   ├── integration/              ← partner SDK
        │   ├── matching/                 ← MatchingEngine, MatchingScoreServiceImpl
        │   └── taskimport/               ← module lớn nhất
        │       ├── parser/  validator/  storage/  registry/  labelconfig/  support/
        │       ├── directfile/  asset/  sftp/
        │       └── external/             ← provider/ scan/ schedule/ manifest/ archive/ crypto/ portal/
        │
        ├── repository/                   ← 47 JpaRepository (+ projection/)
        ├── entities/                     ← 47 @Entity
        ├── dto/                          ← request/response DTO, chia theo domain
        ├── enums/                        ← trạng thái nghiệp vụ
        ├── mapper/                       ← MapStruct
        │
        ├── assignment/                   ← LOGIC PHÂN PHỐI (tách khỏi service/)
        │   ├── model/                    ← AssignmentProfileContext, CompiledAssignmentPolicy…
        │   ├── policy/                   ← Compiler, Validator, Evaluator, Canonicalizer, Hasher
        │   └── recommendation/           ← cache key + DTO cho Redis
        │
        ├── template/                     ← match/ + normalize/ (so khớp label_config với template)
        ├── validation/                   ← validate annotation theo label_config
        │   └── config/  layer/  model/  type/
        │
        ├── client/                       ← LabelStudioClient, AuthClient, NotificationClient, JwtVerifier
        ├── config/                       ← properties, filter, async, RestTemplate, JPA audit
        │   ├── constants/                ← *ErrorCode, PermissionObjectCode, ServicePermissionCode
        │   ├── integration/              ← IntegrationPartnerFilter, PartnerContext, TransactionContext
        │   └── taskimport/
        ├── exception/                    ← GlobalExceptionHandler + exception nghiệp vụ
        ├── job/                          ← 9 @Scheduled job
        ├── logging/  util/
```

### Ba package đáng chú ý vì "không nằm ở chỗ thường thấy"

| Package | Vì sao tách riêng |
|---|---|
| `assignment/` | Logic phân phối là **thuật toán thuần**, không phụ thuộc Spring. Tách khỏi `service/` để test được như unit test bình thường (`policy/` gồm Compiler → Validator → Canonicalizer → Hasher → Evaluator). |
| `template/` | So khớp `label_config` XML với template được hỗ trợ. `normalize/` chuẩn hoá XML thành *logic signature*; `match/` tra danh mục. |
| `validation/` | Validate annotation theo hợp đồng suy ra từ `label_config`. Chia `config/` (resolver + cache), `type/` (từng loại control), `layer/`, `model/`. |

---

## 6. Business Domains

| Domain | Responsibility | Main Controller | Main Service | Main Repository | External Dependency |
|---|---|---|---|---|---|
| **Task & Assignment** | Chọn & giao task cho user, đảm bảo overlap/dedup/no-race | `AssignmentController`, `TaskController` | `TaskDistributionServiceImpl`, `TaskServiceImpl` | `TaskRepository`, `AssignedTaskRepository` | auth-service (profile) |
| **Annotation** | Nhận kết quả gán nhãn, validate, ghi LS + mirror | `AnnotationController` | `AnnotationServiceImpl`, `AnnotationValidationOrchestrator` | `TaskAnnotationRepository` | **Label Studio** |
| **Label Studio Sync** | Đồng bộ project/task 2 chiều | `LsWebhookController` | `SyncServiceImpl` | `ProjectRepository`, `TaskRepository`, `SyncJobLogRepository` | **Label Studio** |
| **Project** | Vòng đời project, dashboard, discovery | `ProjectController` | `ProjectServiceImpl`, `ProjectDiscoveryServiceImpl` | `ProjectRepository` | Label Studio |
| **Assignment Policy** | Điều kiện eligibility theo profile, có version + hash | `ProjectAssignmentPolicyController` | `ProjectAssignmentPolicyServiceImpl`, `AssignmentPolicyEvaluatorImpl` | `ProjectAssignmentPolicyRepository` | – |
| **Campaign & Reward** | Chiến dịch, gói project + thưởng, vòng đời DRAFT→ACTIVE→CLOSED | `CampaignController`, `RewardController` | `CampaignServiceImpl` | `CampaignRepository`, `CampaignProjectRepository` | notification-service |
| **Qualification** | Bài thi sát hạch đầu vào của campaign | `CampaignQualificationController`, `QualificationAttemptController` | `QualificationAttemptServiceImpl`, `QualificationPoolServiceImpl`, `QualificationAssignmentGate` | `QualificationAttemptRepository`, `CampaignQualificationConfigRepository` | – |
| **Question Bank** | Ngân hàng câu hỏi + bộ đề (dùng cho qualification & project SURVEY) | `QuestionController`, `QuestionSetController` | `QuestionServiceImpl`, `QuestionSetServiceImpl` | `QuestionRepository`, `QuestionSetRepository` | – |
| **Task Import** | Nhập dữ liệu Portal/SFTP/S3/MinIO → tạo task trên LS | `TaskImportController`, `TaskImportJobController`, `ExternalStorageController` | `TaskImportServiceImpl`, `ExternalStorageScanService` | `TaskImportJobRepository`, `ExternalStorage*Repository` | **Label Studio**, file-service, S3/MinIO, SFTP |
| **Compensation & Payout** | Sổ cái tiền công + quy trình trả thưởng | `CompensationController`, `PayoutRequestController`, `PayoutRequestAdminController` | `CompensationLedgerWriter`, `PayoutProcessingServiceImpl` | `CompensationTransactionRepository`, `PayoutRequestRepository` | notification-service |
| **Partner Integration** | Cổng SDK service-to-service cho đối tác | `IntegrationController`, `PartnerAdminController` | `PartnerTaskSyncServiceImpl`, `PartnerUserSyncServiceImpl` | `IntegrationPartnerRepository`, `PartnerUserMappingRepository` | auth-service |
| **Recommendation** | Gợi ý task màn Home, cache Redis | `TaskRecommendationController` | `TaskRecommendationServiceImpl`, `RecommendedTaskAssignmentServiceImpl` | `TaskRepository` | **Redis** |
| **Media** | Proxy file của LS bằng signed URL | `MediaController`, `ExternalAssetController` | `MediaServiceImpl`, `MediaSigningServiceImpl` | – | **Label Studio**, S3/MinIO |

📄 Chi tiết từng domain: [`../services/`](../services/)

---

## 7. API Architecture

### Quy ước chung của mọi controller

```java
@RestController
@RequestMapping("/xxx")
@RequiredArgsConstructor
@FieldDefaults(level = AccessLevel.PRIVATE, makeFinal = true)   // Lombok: field tự thành private final
@Tag(name = "...", description = "...")                          // Swagger
public class XxxController {
  AuthClient authClient;          // luôn có
  XxxService xxxService;

  @GetMapping("/...")
  public ResponseEntity<?> foo(HttpServletRequest servletRequest, ...) throws Exception {
    authClient.checkAuthorization(servletRequest);                // 1. kiểm token có mặt
    UUID userId = authClient.getUserUUIDFromToken(servletRequest);// 2. lấy user (nếu cần)
    return ResponseEntity.ok(GetMethodResponse.builder()          // 3. wrap response
        .data(...).status(true).httpCode(200).message("OK").build());
  }
}
```

Ba điểm cần nhớ:
1. **Không có `@PreAuthorize`.** Kiểm quyền gọi tay bằng `authClient.checkAuthorization` /
   `authClient.verifyPermission`.
2. **Response luôn bọc `GetMethodResponse` / `BaseMethodResponse`** (từ `com.ttt.core:common`).
3. **HTTP status luôn 200**, mã lỗi thật nằm trong body — xem §17.

### API map (chỉ API có business logic; bỏ CRUD nhỏ)

| Domain | Method | Endpoint | Controller | Service | Purpose |
|---|---|---|---|---|---|
| Assignment | POST | `/assignments/request` | `AssignmentController` | `TaskDistributionServiceImpl.requestTask` | **Xin task mới — API quan trọng nhất** |
| Assignment | GET | `/assignments` | `AssignmentController` | `TaskDistributionServiceImpl.getMyTasks` | Assignment của tôi |
| Assignment | POST | `/assignments/admin/direct` | `AssignmentController` | `.directAssign` | Admin gán tay |
| Recommendation | GET | `/assignments/recommendations` | `TaskRecommendationController` | `TaskRecommendationServiceImpl` | Gợi ý "Dành cho bạn" (Redis) |
| Recommendation | POST | `/assignments/recommendations/{id}/assign` | `TaskRecommendationController` | `RecommendedTaskAssignmentServiceImpl.assign` | Nhận task từ gợi ý (revalidate + lock) |
| Task | GET | `/tasks/{taskId}` | `TaskController` | `TaskServiceImpl.getTaskById` | Nội dung task (gọi LS + ký lại media URL) |
| Task | GET | `/tasks/my-assigned` | `TaskController` | `.getMyAssignedTasksInProject` | Filter/sort + `statusCounts` |
| Task | GET | `/tasks/assignable` | `TaskController` | `.getAssignableTasks` | Task còn suất overlap |
| Annotation | POST | `/annotations?assignedTaskId=` | `AnnotationController` | `AnnotationServiceImpl.createAnnotation` | **Submit kết quả gán nhãn** |
| Annotation | POST | `/annotations/{annotationId}` | `AnnotationController` | `.updateAnnotation` | Sửa annotation |
| Webhook | POST | `/internal/webhooks/label-studio` | `LsWebhookController` | `SyncServiceImpl.handle*` | LS bắn event |
| Project | POST | `/projects` | `ProjectController` | `ProjectServiceImpl` | Tạo project (tạo luôn trên LS) |
| Project | GET | `/projects/{id}/dashboard` | `ProjectController` | `ProjectServiceImpl` | Thống kê + warning |
| Project | GET | `/projects/discover` | `ProjectController` | `ProjectDiscoveryServiceImpl` | Khám phá project |
| Policy | PUT | `/projects/{uuid}/assignment-policy` | `ProjectAssignmentPolicyController` | `ProjectAssignmentPolicyServiceImpl` | Compile + validate + hash policy |
| Campaign | POST | `/campaigns/{id}/approve` | `CampaignController` | `CampaignServiceImpl.approveCampaign` | DRAFT→ACTIVE + **freeze đề thi** |
| Campaign | POST | `/campaigns/{id}/activate` | `CampaignController` | `.activateCampaign` | INACTIVE→ACTIVE + freeze lại |
| Campaign | GET | `/campaigns/public` | `CampaignController` | `.listPublicCampaigns` | `isPublic=true AND status=ACTIVE` |
| Qualification | POST | `/campaigns/{id}/qualification/attempts` | `CampaignQualificationAttemptController` | `QualificationAttemptServiceImpl.startAttempt` | Bắt đầu thi |
| Qualification | POST | `/qualification/attempts/{id}/submit` | `QualificationAttemptController` | `.submit` | Nộp bài + chấm (lock chống chấm 2 lần) |
| Qualification | GET | `/campaigns/{id}/qualification/readiness` | `CampaignQualificationController` | `QualificationReadinessServiceImpl` | Campaign đủ điều kiện approve chưa |
| Task Import | POST | `/projects/{uuid}/task-imports/preview` | `TaskImportController` | `TaskImportServiceImpl` | Parse + validate, **chưa ghi gì** |
| Task Import | POST | `/projects/{uuid}/task-imports` | `TaskImportController` | `.createImport` | Tạo job import |
| Task Import | POST | `/task-import-jobs/{uuid}/retry` | `TaskImportJobController` | `TaskImportJobServiceImpl` | Retry (idempotent) |
| External Storage | POST | `/external-storage/schedules/{uuid}/run-now` | `ExternalStorageController` | `ExternalStorageRunService` | Chạy lịch quét ngay |
| Compensation | GET | `/compensation/summary` | `CompensationController` | `CompensationQueryServiceImpl` | Số dư |
| Payout | POST | `/payout-requests` | `PayoutRequestController` | `PayoutRequestServiceImpl.createRequest` | Xin rút (lock summary + RESERVE) |
| Payout | POST | `/admin/payout-requests/{uuid}/mark-paid` | `PayoutRequestAdminController` | `PayoutProcessingServiceImpl` | Đã chi (lock + SETTLEMENT) |
| Integration | POST | `/integration/users/init` | `IntegrationController` | `PartnerUserSyncServiceImpl` | Partner tạo user |
| Integration | POST | `/integration/tasks/request` | `IntegrationController` | `PartnerTaskSyncServiceImpl` | Partner xin task (pool chung) |
| Integration | POST | `/integration/tasks/{id}/submit` | `IntegrationController` | `PartnerAnnotationSyncServiceImpl` | Partner submit |
| Media | GET | `/media/**` | `MediaController` | `MediaServiceImpl` | Proxy file LS bằng signed URL |

Swagger UI đầy đủ: `http://<host>:9090/swagger-ui/index.html`

---

## 8. Database Architecture

### Nguyên tắc chung

| Nguyên tắc | Chi tiết |
|---|---|
| **Base entity** | Hầu hết entity kế thừa `BaseEntity`: `id` (BIGINT AUTO_INCREMENT), `uuid` (VARCHAR unique, sinh ở `@PrePersist`), `creator_id`/`updater_id`/`deleter_id`, `created_time`/`modified_time`, `is_deleted` |
| **ID đối ngoại là UUID** | API **chỉ nhận/trả `uuid`**, không lộ `id` tự tăng. `id` chỉ dùng nội bộ (FK, join) |
| **Xoá mềm** | `is_deleted = true`. Ngoài ra `projects`/`tasks` còn có `ls_deleted` (LS đã xoá). **Mọi query nghiệp vụ phải kèm `is_deleted = false AND ls_deleted = false`** |
| **Audit tự động** | `@EnableJpaAuditing` + `AuditorProvider` đọc `CurrentUserContext` (ThreadLocal do `CurrentUserFilter` set) |
| **Migration thủ công** | 37 file `src/main/resources/db/migration/V*.sql`. **Không có Flyway/Liquibase runtime** — DBA/dev chạy tay. `ddl-auto: none` |
| **FK lỏng** | Nhiều quan hệ **không có FK vật lý** (ví dụ `tasks.project_id`). Xem §13 Risk |

### Bảng chính (47 entity → 47 bảng)

| Entity | Table | Relationship | Business Meaning |
|---|---|---|---|
| `Project` | `projects` | 1-N `tasks` (qua `project_id`, **không FK**) | Lô việc; mirror LS project. `ls_project_id` unique, NULL với SURVEY |
| `Task` | `tasks` | N-1 `projects`; 1-N `assigned_tasks` | Đơn vị gán nhãn. `overlap`, `annotation_count`, `task_status` |
| `AssignedTask` | `assigned_tasks` | N-1 `tasks`, N-1 `projects` | 1 lượt giao. `status`, `expired_at`, **`version` (@Version)**, 4 cột snapshot |
| `TaskAnnotation` | `task_annotations` | N-1 `tasks`, N-1 `assigned_tasks` | Kết quả gán nhãn. `ls_annotation_id`, `result_json` |
| `ProjectAssignmentPolicy` | `project_assignment_policies` | N-1 `projects` | Policy có version, chỉ 1 row `enabled` |
| `AssignmentConditionDefinition` / `Option` | `assignment_condition_definitions` / `_options` | 1-N | Danh mục field/giá trị dùng viết policy |
| `Campaign` | `campaigns` | N-N `projects`, N-N `rewards` | Chiến dịch |
| `CampaignProject` / `CampaignReward` | `campaign_projects` / `campaign_rewards` | bảng nối | |
| `Reward` | `rewards` | | Phần thưởng |
| `AnnotationTemplate` | `annotation_templates` | 1-N `projects` (`template_id`) | Danh mục template được hỗ trợ |
| `SyncJobLog` | `sync_job_log` | – | **Nhật ký reconcile — nơi debug sync đầu tiên** |
| `Question` / `QuestionOption` | `questions` / `question_options` | 1-N | Ngân hàng câu hỏi |
| `QuestionSet` / `QuestionSetItem` | `question_sets` / `question_set_items` | 1-N | Bộ đề |
| `CampaignQualificationConfig` | `campaign_qualification_configs` | N-1 `campaigns` | Cấu hình test, có `version` + **`frozen`** + `required` |
| `CampaignQualificationSetRule` / `PoolItem` | `..._set_rules` / `..._pool_items` | N-1 config | Rule bốc đề / pool đã freeze |
| `QualificationQuestionDefinition` | `qualification_question_definitions` | | Câu hỏi + đáp án + grading, có `verification_status` |
| `QualificationQuestionReview` | `qualification_question_reviews` | N-1 definition | Lượt duyệt (cần 2 reviewer) |
| `QualificationAttempt` | `qualification_attempts` | N-1 config | 1 lượt thi. `attempt_number`, `expires_at`, `overall_score` |
| `QualificationAttemptQuestion` / `Answer` | `..._questions` / `..._answers` | N-1 attempt | Snapshot đề + câu trả lời |
| `CompensationTransaction` | `compensation_transactions` | | **Sổ cái bất biến**, `idempotency_key` UNIQUE |
| `UserCompensationSummary` | `user_compensation_summaries` | | Số dư, UNIQUE `(user_id, currency)` |
| `PayoutAccount` | `payout_accounts` | | Tài khoản nhận tiền |
| `PayoutRequest` | `payout_requests` | 1-N `payout_attempts` | Yêu cầu rút |
| `PayoutAttempt` | `payout_attempts` | N-1 request | Từng lần chi |
| `PayoutNotification` | `payout_notifications` | | **Outbox** thông báo |
| `UserPayoutCapability` | `user_payout_capabilities` | | ACTIVE / SUSPENDED |
| `TaskImportJob` | `task_import_jobs` | 1-N items, 1-N files | 1 lần import |
| `TaskImportItem` | `task_import_items` | N-1 job | 1 dòng → 1 task (`ls_task_id`) |
| `TaskImportJobFile` | `task_import_job_files` | N-1 job | File trong job batch |
| `TaskImportSftpSource` / `File` | `task_import_sftp_*` | | Nguồn SFTP (module cũ) |
| `ExternalStorageProfile` | `external_storage_profiles` | 1-N schedules | Kết nối S3/MinIO/SFTP, credential mã hoá AES-GCM |
| `ExternalStorageSchedule` | `external_storage_schedules` | 1-N runs | Lịch quét |
| `ExternalStorageRun` | `external_storage_runs` | 1-N batches | 1 lần chạy lịch |
| `ExternalImportBatch` / `BatchJob` | `external_import_batches` / `_batch_jobs` | | Thư mục batch → job |
| `ExternalTaskAsset` | `external_task_assets` | | File media đi kèm task |
| `ExternalDuplicateRegistryEntry` | `external_duplicate_registry` | | Chống import trùng |
| `IntegrationPartner` | `integration_partners` | 1-N mappings | Partner |
| `PartnerUserMapping` | `partner_user_mappings` | N-1 partner | `externalUserId` ↔ `questlabUserId` |
| `IntegrationTransactionLog` | `integration_transaction_logs` | | Log đối soát |

### Quan hệ cốt lõi (đã kiểm chứng bằng query trong repository)

```
        annotation_templates
                 │ template_id
                 ▼
   campaigns ──N-N── projects ────1-N──── tasks ────1-N──── assigned_tasks
       │      (campaign_          │                              │
       │       projects)          │ 1-1 (enabled)                │ 1-1
       │                          ▼                              ▼
       │            project_assignment_policies          task_annotations
       │ 1-N                                                     │
       ▼                                                         │
 campaign_qualification_configs ──1-N── qualification_attempts    │
       │                                                         │
       │ N-N (campaign_rewards)                                  ▼
       ▼                                        compensation_transactions
    rewards                                                 │
                                                            ▼
                                             user_compensation_summaries
                                                            │
                                                            ▼
                                         payout_requests ──1-N── payout_attempts
                                                 │
                                                 ▼
                                          payout_notifications (outbox)
```

> ⚠️ Các mũi tên trên là quan hệ **logic** (được xác nhận qua JPQL/native query trong
> repository). Nhiều quan hệ **không có FK vật lý** — code không dùng `@ManyToOne`/`@OneToMany`
> mà lưu id thô (`projectId`, `taskId`, `userId`) và join thủ công. Đây là quyết định thiết kế
> nhất quán của codebase: tránh lazy-loading bất ngờ và N+1.

---

## 9. Main Business Flows

📄 Chi tiết đầy đủ 10 flow + sequence diagram: [`../flows/main-business-flows.md`](../flows/main-business-flows.md)

Tóm tắt 3 flow quan trọng nhất:

### 9.1 Request Task — `POST /assignments/request`

```
Client ─► CurrentUserFilter ─► AssignmentController ─► TaskDistributionServiceImpl @Transactional
   1. countActiveByUserId          → quota (max 10)
   2. AuthProfileClient            → auth-service (lỗi = 503, không gán bừa)
   3. profileContextBuilder.build  → context phẳng
   4. ProjectEligibilityService    → lọc project ACTIVE+MATCHED+chưa hết hạn, chạy policy
   5. QualificationAssignmentGate  → loại project của campaign yêu cầu thi
   6. TaskRepository.findNextAssignableTaskId  → native SQL + FOR UPDATE  ◄── KHOÁ ROW
   7. INSERT assigned_tasks (PENDING, hạn 3 ngày, kèm snapshot policy)
   8. UPDATE tasks → IN_PROGRESS
```

### 9.2 Submit Annotation — `POST /annotations`

```
AnnotationController ─► AnnotationServiceImpl @Transactional
   assignment PENDING? → chưa hết hạn? → đúng chủ? → task khả dụng?
   → validate theo label_config
   → LabelStudioClient.createAnnotation  (GHI VÀO LS TRƯỚC — lấy ls_annotation_id)
   → INSERT task_annotations + assigned_tasks=ANNOTATED + annotation_count++
   → đủ overlap → tasks=COMPLETED
   → Redis enqueueWatchlist
```

### 9.3 Label Studio Sync (webhook + reconcile)

```
LS ─webhook─► LsWebhookController ─@Async─► SyncServiceImpl.handle*   (fast path, trả 200 ngay)
ReconciliationJob (3 phút) ─► SyncServiceImpl.reconcile*              (safety net)
     FETCH (phân trang LS) → SAFETY CHECK → DIFF → APPLY → ghi sync_job_log
```

---

## 10. Label Studio Integration

📄 Chi tiết: [`../services/label-studio.md`](../services/label-studio.md) ·
[`../services/label-studio.d2`](../services/label-studio.d2)

### Tóm tắt

| Câu hỏi | Trả lời |
|---|---|
| Questlab đóng vai gì? | Lớp điều phối nhân lực (assignment, overlap, campaign, tiền) |
| Label Studio đóng vai gì? | Kho dữ liệu + trình soạn nhãn (`label_config`, task data, annotation) |
| Project sync thế nào? | Webhook `PROJECT_*` (async) + reconcile 3 phút/lần; qua **template gate** |
| Task sync thế nào? | Webhook `TASK_CREATED/DELETED` + reconcile per project; `INSERT IGNORE` (idempotent) |
| Assignment sync thế nào? | **Không sync** — LS hoàn toàn không biết Questlab giao task cho ai |
| Annotation lưu ở đâu? | Ghi vào LS **trước** (`POST /api/tasks/{id}/annotations`), rồi mirror `task_annotations` |
| Webhook thế nào? | `POST /internal/webhooks/label-studio`, trả 200 ngay, xử lý `@Async("lsSyncExecutor")` |
| Reconcile để làm gì? | Webhook có thể mất (LS down, restart, thread pool reject) → eventual consistency ≤3 phút |

### Source of Truth

| Data | Source of Truth | Ghi chú |
|---|---|---|
| Project metadata + `label_config` | **Label Studio** | Ngoại lệ: project do Questlab tạo, và `SURVEY` (`ls_project_id = NULL`) |
| Task `data_json` | **Label Studio** | Reconcile đè local |
| Task lifecycle (`task_status`, `overlap`, `annotation_count`) | **Questlab** | LS không có khái niệm này |
| Assignment | **Questlab** | |
| Annotation nội dung | **Label Studio** | `ls_annotation_id` do LS cấp |
| Annotation metadata (ai, lúc nào, assignment nào) | **Questlab** | |
| Campaign / Qualification / Compensation | **Questlab** | Không tồn tại ở LS |

### Template gate — cơ chế quan trọng nhất

Project LS chỉ được phân phối khi `label_config` của nó **khớp một `AnnotationTemplate` đã hỗ
trợ**. Không khớp → `project_status = INACTIVE`, `task_status = UNAVAILABLE` → không bao giờ
được giao. Bật/tắt bằng `sync.template-gate.enabled`.

---

## 11. Redis

📄 Chi tiết: [`../services/recommendation.md`](../services/recommendation.md)

**Redis được dùng — nhưng chỉ cho MỘT tính năng: Home recommendation.**

| Mục đích | Có dùng? |
|---|---|
| Caching (chức năng gợi ý) | ✅ |
| Temporary data (lookup id gợi ý) | ✅ |
| Queue nhẹ (watchlist refill) | ✅ (Redis Hash) |
| **Distributed lock** | ❌ không có Redisson/ShedLock |
| **Session** | ❌ (JWT stateless) |
| **Rate limiting** | ❌ |
| `@Cacheable` / `@CacheEvict` của Spring | ❌ (dùng `CacheRedisService` của `com.ttt.base:cache`) |

| Key | Kiểu | TTL |
|---|---|---|
| `questlab:recommendations:user:{userId}` | String JSON | 600 s |
| `questlab:recommendations:id:{recommendationId}` | String JSON | 600 s |
| `questlab:recommendations:watchlist` | **Hash** userId→"1" | không TTL |

**Redis chết thì sao?** Mọi thao tác bọc `catch (DataAccessException)` → log `REDIS_DOWN` → coi
như cache miss → degrade sang query SQL. `POST /assignments/request` **không đụng Redis** nên
luồng xin việc chính không bị ảnh hưởng.

**Evidence:** `service/impl/TaskRecommendationCacheServiceImpl.java`,
`assignment/recommendation/RecommendationCacheKeys.java`, `config/CacheServiceConfig.java`

---

## 12. Kafka / Messaging

```
Kafka is not used by questlab-service based on current source.
RabbitMQ is not used by questlab-service based on current source.
```

**Evidence:** grep `KafkaTemplate|@KafkaListener|RabbitTemplate|@RabbitListener|kafka|rabbit`
trên `src/main/java` + `src/main/resources` → chỉ **1** hit, và đó là một **comment** trong
`client/NotificationClient.java:49` mô tả hành vi của service khác:

> *"Notification-service ghi `notification_log` rồi đẩy Kafka và trả ngay — 'đã nhận', chưa
> phải 'đã gửi tới hộp thư'."*

**Kafka tồn tại trong hệ sinh thái nhưng ở `notification-service`**:
`notification-service/src/main/java/com/ttt/notification/kafka/NotificationConsumer.java` có
`@KafkaListener(topics = "${kafka.topics.notification}", groupId = "${spring.kafka.consumer.group-id}")`,
dùng **một consumer group duy nhất cho tất cả topic** (quyết định ghi trong javadoc
`KafkaConsumerConfig`). Questlab giao tiếp với nó qua **HTTP**, không qua Kafka.

### Thay thế cho messaging trong Questlab

| Nhu cầu | Giải pháp trong source |
|---|---|
| Xử lý bất đồng bộ | `@Async("lsSyncExecutor")` + `ThreadPoolTaskExecutor` |
| Hàng đợi công việc | Bảng DB + `@Scheduled` poll (`task_import_jobs`, `payout_notifications`) |
| Outbox / at-least-once | `payout_notifications` + `PayoutNotificationDispatchJob` |
| Dedup hàng đợi | Redis Hash (`watchlist`) |

---

## 13. Transaction & Concurrency

Đây là phần **quan trọng nhất** để hiểu project và cũng là phần được hỏi nhiều nhất.

### 13.1 Bản đồ khoá trong source

| Cơ chế | Nơi dùng | File |
|---|---|---|
| **`FOR UPDATE`** (native SQL) | `findNextAssignableTaskId`, `lockRecommendedTaskForUser`, `findNextAvailableTaskIdAnywhere`, `findNextAvailableTaskIdOutsideGatedCampaigns` | `repository/TaskRepository.java` |
| **`@Lock(PESSIMISTIC_WRITE)`** | `UserCompensationSummaryRepository`, `PayoutRequestRepository`, `PayoutAccountRepository`, `UserPayoutCapabilityRepository`, `QualificationAttemptRepository`, `ExternalStorageProfileRepository` | 6 repository |
| **`@Version`** (optimistic) | `AssignedTask.version` | `entities/AssignedTask.java` |
| **Compare-and-set trên cột status** | `TaskImportJobService.claimStatus` | `job/taskimport/TaskImportWorkerJob.java` |
| **`UNIQUE` constraint làm khoá** | `compensation_transactions.idempotency_key`, `user_compensation_summaries(user_id, currency)` | migration V32 |
| **`synchronized`** | `AssignmentConditionDefinitionServiceImpl.evictCache` (cache in-memory), `SftpExternalStorageProvider` | 2 nơi |
| **`@Async`** | `SyncServiceImpl.handle*` (`lsSyncExecutor`), notification | `config/AsyncConfig.java` |

**Không có:** `CompletableFuture`, `AtomicInteger/AtomicLong` cho logic nghiệp vụ, distributed
lock.

### 13.2 Bài toán kinh điển: hai user cùng xin task

```
User A                                  User B
  BEGIN TX                                BEGIN TX
  SELECT t.id FROM tasks t
    WHERE ... overlap slot còn ...
    ORDER BY ... LIMIT 1
    FOR UPDATE                     ─────► khoá row task #100
                                          SELECT ... FOR UPDATE
                                          ⏸ BLOCKED — chờ row #100
  INSERT assigned_tasks (PENDING)
  UPDATE tasks → IN_PROGRESS
  COMMIT                           ─────► nhả khoá
                                          ▶ unblock
                                          InnoDB dùng CURRENT READ (không phải snapshot MVCC)
                                          → đọc lại assigned_tasks với dữ liệu MỚI của A
                                          → subquery COUNT(*) < overlap được tính lại
                                          → nếu hết suất: task #100 bị loại, chọn task khác
```

Javadoc của `findNextAssignableTaskId` giải thích chính xác điều này:

> *"FOR UPDATE: lock row tasks được chọn. InnoDB dùng current read khi T2 unblock sau T1 commit,
> nên assigned_tasks được re-read với data mới nhất → serialization đúng."*

**Chi tiết cần hiểu:** khoá đặt trên row **`tasks`**, còn điều kiện overlap đếm trên
**`assigned_tasks`**. Điều này an toàn vì **mọi** đường cấp task đều phải khoá row `tasks` đó
trước — 4 query cấp task đều có `FOR UPDATE` trên `tasks`.

### 13.3 Ba mô hình idempotency khác nhau trong project

| Mô hình | Nơi dùng | Cách hoạt động |
|---|---|---|
| **UNIQUE key + đọc lại** | Compensation | `UNIQUE(idempotency_key)` → `DataIntegrityViolationException` → đọc lại bút toán của luồng thắng ở **transaction mới** (vì transaction của luồng thua đã rollback) |
| **Pessimistic lock + terminal state** | Qualification submit | `lockByUuid` (PESSIMISTIC_WRITE) → luồng thứ hai thấy trạng thái terminal → trả kết quả đã lưu |
| **Compare-and-set + state machine** | Task Import | `claimStatus(id, from, to)` → 0 row = thua; `ImportJobStatus.canTransitionTo` chặn regress từ terminal |

Thêm: `POST /annotations` **de-facto idempotent** vì bước 1 đòi assignment `PENDING`; sau lần
submit đầu tiên status thành `ANNOTATED` nên lần 2 nhận 404.

### 13.4 Thứ tự khoá — chống deadlock

Module Payout khoá theo thứ tự **cố định**: `payout_requests` **trước**, `user_compensation_summaries`
**sau**. Javadoc `PayoutProcessingServiceImpl`:

> *"Thứ tự khoá giống Phase 4: request trước, summary sau. Không đường nào khoá ngược lại, nên
> hai luồng không tạo thành vòng chờ."*

### 13.5 Điểm cần biết khi debug (không phải khuyến nghị — là hiện trạng)

| Vấn đề | Chi tiết |
|---|---|
| **HTTP call trong transaction** | `AnnotationServiceImpl.createAnnotation` `@Transactional` gọi Label Studio (response timeout **120 s**). `TaskDistributionServiceImpl.requestTask` `@Transactional` gọi auth-service. DB connection bị giữ suốt thời gian đó |
| **`@Transactional protected` + self-invocation** | `RecommendedTaskAssignmentServiceImpl.revalidateAndAssign` được gọi từ `assign()` cùng class → Spring proxy không chặn → **annotation không có hiệu lực**. An toàn nhờ `FOR UPDATE` trong query |
| **Webhook handler không có `@Transactional`** | `SyncServiceImpl.handle*` — mỗi lệnh repository là 1 transaction riêng. Lỗi giữa chừng để lại trạng thái một phần, reconcile chữa sau ≤3 phút |
| **Multi-replica + `@Scheduled`** | Không có ShedLock/distributed lock. An toàn nhờ SQL idempotent (`INSERT IGNORE`, `UPDATE ... WHERE status=`) và, riêng Task Import, `claimStatus`. `ReconciliationJob` chạy trên **mọi** replica |
| **Correlated subquery 3 tầng** | Điều kiện `max_overlap_ratio` trong query chọn task. Javadoc đề nghị index `assigned_tasks(project_id, user_id, status)` khi dataset lớn |
| **`CallerRunsPolicy`** | `lsSyncExecutor` đầy (20 thread + 100 queue) → task chạy trên chính thread HTTP của webhook → webhook chậm thay vì mất event |

---

## 14. Scheduler

`@EnableScheduling` trên `QuestlabApplication`. **9 job**, tất cả trong package `job/`.

| Job | Cron / Delay | Property | Service gọi tới | Purpose |
|---|---|---|---|---|
| `ReconciliationJob` | `0 */3 * * * *` | `sync.reconciliation.cron` | `SyncServiceImpl` | Đồng bộ project/task với Label Studio |
| `AssignmentExpiryJob` | `0 0/10 * * * *` | `assignment.expiry.cron` | `AssignedTaskRepository`, `TaskRepository`, cache | `PENDING` quá hạn → `EXPIRED`, task về `AVAILABLE` |
| `CampaignExpiryJob` | `0 0 1 * * *` | `campaign.expiry.cron` | `CampaignRepository` | Đóng campaign quá `end_date` |
| `QualificationAttemptExpiryJob` | `0 */5 * * * *` | `qualification.attempt.expiry-cron` | `QualificationAttemptRepository` | Đóng attempt quá TTL / campaign rời ACTIVE |
| `TaskRecommendationRefillJob` | `0 */5 * * * *` | `recommendations.refill.cron` | `TaskRecommendationCandidateService`, cache | Refill cache gợi ý cho user trong watchlist |
| `TaskImportWorkerJob` | fixedDelay **10 s** | `task-import.worker.fixed-delay-ms` | pipeline import | Chạy job import ASYNC |
| `ExternalStorageSchedulerTick` | `0 * * * * *` | `task-import.external-storage.scheduler-tick-cron` | `ExternalStorageScanService` | Quét S3/MinIO/SFTP theo lịch |
| `SftpImportScannerJob` | `0 */5 * * * *` | `task-import.sftp.scan-cron` | `SftpClientService` | **Tắt mặc định** (`task-import.sftp.enabled=false`) |
| `PayoutNotificationDispatchJob` | fixedDelay **30 s** | `compensation.notification.fixed-delay-ms` | `PayoutNotificationDispatcher` | Đẩy outbox thông báo payout |

### Trace mẫu

```
ReconciliationJob (@Scheduled)
    ↓ SyncService.reconcileProjects()
    ↓ LabelStudioClient.getProjects(page, size)   → Label Studio /api/projects
    ↓ ProjectRepository.insertIfAbsent / updateFromWebhook / markLsDeletedByLsIds
    ↓ MariaDB
    ↓ SyncJobLogRepository.save(...)              → bảng sync_job_log
```

### Cách xử lý lỗi của các job (mẫu chung)

| Job | Chiến lược |
|---|---|
| `ReconciliationJob` | `reconcileProjects` lỗi → **return ngay** (task reconcile vô nghĩa nếu project sai). Lỗi 1 project → đếm `projectsFailed`, **tiếp tục** |
| `PayoutNotificationDispatchJob` | **Nuốt** `RuntimeException` — row vẫn nằm trong outbox nên không mất gì |
| `TaskRecommendationRefillJob` | `AuthProfileUnavailableException` → **re-enqueue**; lỗi khác → đếm, không re-enqueue |
| `TaskImportWorkerJob` | `reclaimStaleQueued()` cứu job mồ côi sau 15 phút |

---

## 15. External Integrations

| System | Client | Called From | Purpose |
|---|---|---|---|
| **Label Studio** | `LabelStudioClient` (RestTemplate) | `SyncServiceImpl`, `AnnotationServiceImpl`, `TaskServiceImpl`, `ProjectServiceImpl` | CRUD project/task/annotation |
| **Label Studio** | `LabelStudioImportClient` | `TaskImportWorkerJob`, `TaskImportServiceImpl` | Import task (multipart + poll) |
| **Label Studio** | `HttpURLConnection` trực tiếp | `MediaServiceImpl` | Proxy media (cần kiểm soát redirect + header) |
| **auth-service** | `AuthClient` | mọi controller | Decode JWT, `checkAuthorization`, `verifyPermission` |
| **auth-service** | `AuthProfileClientImpl` | `TaskDistributionServiceImpl`, `PartnerUserSyncServiceImpl` | `/member-profile`, `/user/uuid/{uuid}`, `/internal/users/provision(-session)` |
| **auth-service** | `AuthAdminClient` | `PartnerAdminController` flow | Quản trị client/api-key |
| **notification-service** | `NotificationClientImpl` | `CampaignNotificationServiceImpl`, `PayoutNotificationDispatcher` | Push FCM / mail |
| **file-service** | `FileServiceApiImplClient` | `ImportFileStorage` | Upload + lấy URL file |
| **S3 / MinIO** | `S3ExternalStorageProvider` (AWS SDK v2) | `ExternalStorageScanService` | List/stream/move file |
| **SFTP** | `SftpExternalStorageProvider` (Mina SSHD) | `ExternalStorageScanService` | List/stream/move file |
| **Config Server** | Spring Cloud Config | bootstrap | Nạp config |
| **Eureka** | Spring Cloud Netflix | – | `registerWithEureka: false`, `fetchRegistry: false` — **client tồn tại nhưng thực tế không dùng service discovery**; địa chỉ service khác hardcode trong config |

### Kiến trúc tích hợp

```
                         ┌──────────────► Label Studio (project/task/annotation/import/media)
                         │
                         ├──────────────► auth-service     (JWT, profile, provision user)
     questlab-service ───┤
                         ├──────────────► notification-service (push FCM / mail)
                         │
                         ├──────────────► file-service     (lưu file import)
                         │
                         ├──────────────► S3 / MinIO       (external storage import)
                         │
                         └──────────────► SFTP server      (external storage import)
```

### `RestTemplateConfig` — chi tiết đáng học

Một `RestTemplate` duy nhất cho mọi outbound call, cấu hình chống
`NoHttpResponseException` bằng 3 lớp:

1. `validateAfterInactivity = 2 s` — kiểm tra lại connection idle >2 s trước khi tái dùng.
2. `evictIdleConnections = 10 s` — chủ động dọn connection idle (**phải ngắn hơn** keep-alive
   của server; Django/nginx thường 5-15 s).
3. `DefaultHttpRequestRetryStrategy(3, 500ms)` — retry GET/HEAD trên lỗi I/O tạm thời; **POST
   chỉ retry trên `NoHttpResponseException`** (server chưa xử lý request → retry an toàn).

Timeout: connect 5 s, **response 120 s** (import LS lô lớn cần lâu), pool 100 total / 20 per route.

**Evidence:** `config/RestTemplateConfig.java`

---

## 16. Authentication & Authorization

### Questlab **không tự xác thực** — nó nhận identity từ hệ thống khác

Không có Spring Security. Không có `SecurityConfig`, không có `@PreAuthorize`.

### Flow cho người dùng thường

```
Mobile App / Portal
   │  Authorization: Bearer <JWT do auth-service phát hành>
   ▼
API Gateway   (strip Authorization của client, chỉ forward JWT hợp lệ)
   ▼
CurrentUserFilter  (OncePerRequestFilter)
   │  shouldNotFilter: path bắt đầu bằng
   │     /media/ · /swagger-ui · /v3/api-docs · /swagger-resources · /integration/
   │  authClient.getUserUUIDFromToken(request)   → Base64-decode payload, lấy claim "sub"
   │  CurrentUserContext.set(userId)             → ThreadLocal, dùng cho JPA auditing
   │  lỗi → 401 "Unauthorized" (log warn, KHÔNG log giá trị token)
   │  finally → CurrentUserContext.clear()
   ▼
Controller
   authClient.checkAuthorization(request)                              ← có token không
   authClient.verifyPermission(request, objectId, objectCode, code)    ← có quyền không
   │     đọc claim "permissions" trong JWT (generalPermissions + specificPermissions)
   │     không đủ → ForbiddenException
   ▼
Service / Repository
```

### Flow cho partner (`/integration/**`)

```
Partner backend ──(x-api-key)──► Gateway ──(đổi thành JWT qua auth-service)──► questlab
   ▼
IntegrationPartnerFilter
   JWT.sub (= base_user.uuid của owner user)
      → auth_client.owner_id → auth_client.id → integration_partners.auth_client_id
   PartnerContext.set(partnerId, partnerCode)
   transactionId (header) bắt buộc → thiếu = 400 TRANSACTION_ID_REQUIRED
   X-Partner-Code không khớp → 403 PARTNER_CODE_MISMATCH
   finally → clear cả hai ThreadLocal
   ▼
IntegrationController
   authClient.verifyPermission(..., ServicePermissionCode.INTEGRATION_*)
```

Lưu ý: `/integration/` nằm trong **WHITE_LIST của `CurrentUserFilter`** — cố ý, vì `sub` của
token là *owner user kỹ thuật của Client*, không phải acting user thật. Set nhầm sẽ ghi sai
`creator_id`/`updater_id`.

### Trust boundary — điều cần hiểu rõ

`AuthClient.extractSub` và `EncodeUtils.decodeJWT` **chỉ Base64-decode payload, KHÔNG kiểm chữ
ký**. Javadoc thừa nhận thẳng đây là mẫu chung của toàn platform (datacore/data-service dùng
đúng cùng hàm). Ranh giới tin cậy là **gateway**.

Hai điều kiện để mô hình này đứng vững (ghi ở
`docs/integration/ADR-001-gateway-trust-boundary.md`):
1. NetworkPolicy chỉ cho gateway tới pod questlab-service;
2. gateway **strip** `Authorization` do client gửi lên.

`JwtVerifier` bổ sung lớp kiểm chữ ký **HMAC-SHA256 riêng cho `/integration/**`**:
allowlist đúng 1 thuật toán `HS256` (chặn `alg: none` và alg-confusion), so sánh
constant-time bằng `MessageDigest.isEqual`, **fail closed** khi thiếu `auth.secret-key`.

Giới hạn (do auth-service quy định, ghi rõ trong javadoc): không check `iss` (auth-service
truyền tên hiển thị user làm issuer); `exp` là **tuỳ chọn** (JWT mint từ api-key dùng
`ttl = -1`); HS256 đối xứng nên verify được nghĩa là ký được.

**Evidence:** `config/CurrentUserFilter.java`, `client/AuthClient.java`, `client/JwtVerifier.java`,
`config/integration/IntegrationPartnerFilter.java`

---

## 17. Error Handling

```
Service ném exception
   ↓
GlobalExceptionHandler   (@RestControllerAdvice)
   ↓
BaseMethodResponse { status:false, message, errorCode, httpCode }
   ↓
Client
```

### ⚠️ Đặc điểm quan trọng nhất: **mọi handler đều `@ResponseStatus(HttpStatus.OK)`**

HTTP status thật **luôn là 200**. Mã lỗi nằm trong **body**:

```json
{ "status": false, "httpCode": 404, "errorCode": "...", "message": "Task not found: ..." }
```

⇒ Khi debug bằng curl/Postman, **đừng nhìn HTTP status** — nhìn `body.status` và `body.httpCode`.

### Bảng exception → mã

| Exception | httpCode trong body | Log level |
|---|---|---|
| `LabelStudioException` | 503 (nếu ex.statusCode==503) hoặc 502 | `error` |
| `TaskImportException` | tự mang `httpCode` + `errorCode` | `debug` |
| `CompensationException` | tự mang | **`warn`** — *"từ chối một thao tác tiền bạc là việc Accounting cần thấy được trong log production"* |
| `BadRequestException` | 400 | `debug` |
| `AnnotationValidationException` | 400 + mảng `errors[{path, code, message}]` | `debug` |
| `InvalidAssignmentPolicyException` | 400 + mảng `errors[{field, operator, reason}]` | `debug` |
| `AuthProfileUnavailableException` | 503 | `warn` |
| `ValidationException`, `MethodArgumentNotValid`, `MissingServletRequestParameter`, `MethodArgumentTypeMismatch` | 400 | `debug`/`error` |
| `UnAuthorizedException` | 401 | `warn` |
| `ForbiddenException` | 403 | `warn` |
| `ResourceNotFoundException`, `UserNotFoundException`, `NoResourceFound`, `NoHandlerFound` | 404 | `debug` |
| `DuplicateEntityException` | 409 | `debug` |
| `HttpMessageNotReadableException` | 400 | `warn` |
| `Exception` (fallback) | 500 `"An unexpected error occurred"` | `error` + stacktrace |

### Error code tập trung

`config/constants/`: `CampaignErrorCode`, `CompensationErrorCode`, `IntegrationErrorCode`,
`PayoutErrorCode`, `ProjectErrorCode`, `QualificationErrorCode`, `QuestionErrorCode`,
`RecommendationErrorCode` + `PermissionObjectCode`, `ServicePermissionCode`.

**Evidence:** `exception/GlobalExceptionHandler.java`

---

## 18. Deployment Architecture

### Dockerfile

```dockerfile
FROM registry.3tit.vn/base/base-docker-image/images/openjdk:17.0.2-oracle
ENV TZ="Asia/Ho_Chi_Minh"
WORKDIR /app
COPY ./target/questlab-service-1.0-SNAPSHOT.jar /app/questlab-service.jar
ENTRYPOINT ["java", "-jar", "/app/questlab-service.jar"]
```

### GitLab CI — 5 stage

```
build  →  set_version  →  package  →  deploy  →  tag
```

| Stage | Nội dung |
|---|---|
| `ci_build` | `mvn clean package -DskipTests`, artifact `target/*.jar` giữ 1 tuần |
| `ci_set_version` | **Parse `#{version}#` từ `$CI_COMMIT_MESSAGE`** (không đọc `pom.xml`); branch dev/qa dùng `$CI_COMMIT_SHORT_SHA` |
| `ci_package` | `docker build` + push `$CI_REGISTRY_IMAGE:$IMAGE_TAG_PREFIX.$BUILD_VERSION` |
| `ci_deploy_k8s` | `git clone questlab-core-helm-repo` → `sed` `values.yaml` đổi image tag → commit + push → **GitOps** |
| `ci_tag` | `git tag` (allow_failure) |

Branch → environment:

| Branch | `CI_EVENT` | `IMAGE_TAG_PREFIX` | `ENVIRONMENT` | Deploy K8s |
|---|---|---|---|---|
| `feature/*` | `dev_commit` | `dev` | qa | ❌ |
| `develop*` | `sit_commit` | `qa` | qa | ✅ |
| `release/*` | `release_package` | `release` | release | ✅ |
| `hotfix/*` | `hotfix_package` | `hotfix` | release | ✅ |
| `master` | `production_package` | `v` | production | ❌ (chỉ build + tag) |

> ⚠️ **Bẫy thường gặp:** commit lên `release`/`hotfix` mà **thiếu `#{version}#`** trong commit
> message → CI không build image mới. Ghi rõ trong `CLAUDE.md`.

### Kubernetes / Helm

**Không có `helm/`, `k8s/`, `deploy/` trong repo này.** Chart nằm ở repo riêng
`git.3tit.vn/base/deployments/k8s/questlab-core-helm-repo`, branch = environment.

⇒ **Chưa đủ evidence trong source để kết luận** về: số replica, resource request/limit,
liveness/readiness probe, ingress, ConfigMap/Secret cụ thể.

Những gì **suy ra được từ repo này**:
- Container port **9090** (`server.port`).
- Health check khả dụng: `management.endpoints.web.exposure.include: "*"` →
  `/actuator/health` (`show-details: always`).
- Config injection: `CONFIG_SERVER_URI` (env) → Spring Cloud Config Server.
  Các biến env khác: `MEDIA_SIGNING_SECRET`, `EXTERNAL_STORAGE_MASTER_KEY`,
  `TASK_IMPORT_LOCAL_PATH`, `MINIO_ACCESS_KEY/SECRET_KEY`, `SFTP_USERNAME/PASSWORD/PRIVATE_KEY`.
- Service discovery: Eureka client có nhưng `registerWithEureka: false` +
  `fetchRegistry: false` → thực tế **không** dùng; địa chỉ service khác là DNS name của K8s
  Service (`ql-auth-service`, `ql-notify-service`, `ql-file-service`, `dpf-eureka-server`,
  `dpf-admin-server`).

---

## 19. Important Code Locations

| Purpose | File / Class |
|---|---|
| **Application entry** | `com/ttt/questlab/QuestlabApplication.java` |
| **Config nghiệp vụ** (cron, ngưỡng, giới hạn) | `src/main/resources/application.yml` |
| **Config bootstrap** | `src/main/resources/bootstrap.yml` |
| **Migration SQL** | `src/main/resources/db/migration/V2..V37` |
| **Xin task (API)** | `controller/AssignmentController.java` |
| **Xin task (logic)** | `service/impl/TaskDistributionServiceImpl.java` |
| **Query chọn task + FOR UPDATE** | `repository/TaskRepository.java` → `findNextAssignableTaskId` |
| **Trả task hết hạn về pool** | `job/AssignmentExpiryJob.java` + `TaskRepository.revertToAvailableWhereNoPending` |
| **Điều kiện eligibility** | `service/impl/ProjectEligibilityServiceImpl.java`, `assignment/policy/AssignmentPolicyEvaluatorImpl.java` |
| **Compile/validate/hash policy** | `assignment/policy/` (Compiler, Validator, Canonicalizer, Hasher) |
| **Gate sát hạch** | `service/qualification/QualificationAssignmentGate.java` |
| **Submit annotation** | `service/impl/AnnotationServiceImpl.java` |
| **Validate annotation theo label_config** | `validation/AnnotationValidationOrchestrator.java`, `validation/config/LabelConfigResolver.java` |
| **Webhook Label Studio** | `webhook/LsWebhookController.java` |
| **Sync + reconcile Label Studio** | `service/impl/SyncServiceImpl.java` |
| **Job reconcile** | `job/ReconciliationJob.java` |
| **HTTP client Label Studio** | `client/LabelStudioClient.java`, `client/LabelStudioImportClient.java` |
| **Template gate** | `template/match/ProjectTemplateMatcher.java`, `template/normalize/TemplateNormalizer.java` |
| **Signed URL media** | `service/impl/MediaSigningServiceImpl.java`, `service/impl/MediaServiceImpl.java` |
| **Redis cache gợi ý** | `service/impl/TaskRecommendationCacheServiceImpl.java`, `assignment/recommendation/RecommendationCacheKeys.java` |
| **Sổ cái tiền** | `service/compensation/CompensationLedgerWriter.java` |
| **Idempotency earning** | `service/compensation/impl/EarningIngressServiceImpl.java` |
| **Luật payout** | `service/payout/PayoutStateMachine.java` |
| **Quy trình chi tiền** | `service/payout/impl/PayoutProcessingServiceImpl.java` |
| **Worker import** | `job/taskimport/TaskImportWorkerJob.java` |
| **State machine import** | `enums/taskimport/ImportJobStatus.java` |
| **Scan external storage** | `job/taskimport/external/ExternalStorageSchedulerTick.java` |
| **Xác thực người dùng** | `config/CurrentUserFilter.java`, `client/AuthClient.java` |
| **Xác thực partner** | `config/integration/IntegrationPartnerFilter.java`, `client/JwtVerifier.java` |
| **Xử lý lỗi tập trung** | `exception/GlobalExceptionHandler.java` |
| **Mã lỗi** | `config/constants/*ErrorCode.java` |
| **Thread pool async** | `config/AsyncConfig.java` |
| **HTTP client chung** | `config/RestTemplateConfig.java` |
| **JPA auditing** | `config/JpaAuditConfig.java`, `config/AuditorProvider.java`, `config/CurrentUserContext.java` |

---

## 20. How To Trace A Request

### Trường hợp 1 — API thuần DB

```
HTTP request
  → CurrentUserFilter            (JWT → CurrentUserContext)
  → XxxController                (checkAuthorization / verifyPermission)
  → XxxService (interface)
  → XxxServiceImpl               (@Transactional nếu có ghi)
  → XxxRepository                (JpaRepository / @Query)
  → MariaDB
  → GetMethodResponse            (wrap lại)
```

Ví dụ: `GET /tasks/list` → `TaskController.listTasks` → `TaskServiceImpl.getTasks` →
`TaskRepository.findTasks` → `tasks`.

### Trường hợp 2 — API có integration

```
HTTP request
  → CurrentUserFilter
  → AnnotationController
  → AnnotationServiceImpl        @Transactional
  → AnnotationValidationOrchestrator  (đọc label_config qua LabelConfigResolver — có cache)
  → LabelStudioClient            → RestTemplate → Label Studio
  → TaskAnnotationRepository / AssignedTaskRepository / TaskRepository
  → MariaDB
  → TaskRecommendationCacheService → Redis
  → response
```

### Trường hợp 3 — không phải HTTP

```
[Scheduler]  @Scheduled → XxxJob → XxxService → XxxRepository → MariaDB (+ External)
[Webhook]    Label Studio → LsWebhookController → @Async lsSyncExecutor → SyncServiceImpl → …
[Partner]    Gateway → IntegrationPartnerFilter → IntegrationController → Partner*SyncService → …
```

### Mẹo tìm nhanh

```bash
# Endpoint nào ở controller nào?
grep -rn '"/assignments' questlab-service/src/main/java/com/ttt/questlab/controller/

# Implementation của interface X?
find questlab-service/src/main/java -name 'X*Impl.java'

# Ai gọi service này?
grep -rn 'TaskDistributionService' questlab-service/src/main/java --include=*.java

# Query nào chạm bảng này?
grep -rn 'assigned_tasks' questlab-service/src/main/java/com/ttt/questlab/repository/
```

Ngoài ra repo có sẵn công cụ sinh bản đồ quan hệ code:
```bash
pip install -r questlab-service/tools/graphify/requirements.txt
bash questlab-service/tools/graphify/scan.sh
# mở questlab-service/tools/graphify/out/graph.html
```

---

## 21. Debugging Guide

### 21.1 Trước tiên — 3 điều dễ nhầm

1. **HTTP status luôn 200.** Lỗi nằm ở `body.status = false` và `body.httpCode`.
2. **Log có `topic`**: `@Slf4j(topic = "SYNC-SERVICE")`, `"LABEL-STUDIO-CLIENT"`,
   `"ANNOTATION-SERVICE"`, `"RECOMMENDATION-CACHE"`, `"COMPENSATION-LEDGER"`,
   `"TASK-IMPORT-WORKER"`, `"INTEGRATION-PARTNER-FILTER"`… → grep theo topic để lọc nhanh.
3. **Log có marker trạng thái**: `[requestTask] START/DONE/QUOTA_EXCEEDED/NO_ELIGIBLE_PROJECT/
   NO_TASK_AVAILABLE/BLOCKED_BY_QUALIFICATION/TASK_FOUND/ASSIGNMENT_CREATED` → đọc marker là
   biết dừng ở bước nào.

### 21.2 Bug ở API thường

```
Controller   → request có tới không? (log của CurrentUserFilter: 401 do thiếu header hay token sai?)
    ↓
Service      → @Transactional có đúng chỗ? có gọi ra ngoài không?
    ↓
Repository   → bật spring.jpa.show-sql=true; kiểm tra điều kiện is_deleted / ls_deleted
    ↓
DB           → chạy tay query trong @Query để so kết quả
```

### 21.3 Bug ở Label Studio

```
1. sync_job_log         ← BẢNG ĐẦU TIÊN CẦN XEM. status, error_message, records_*
2. log topic SYNC-SERVICE      → [handleProjectCreated] / [reconcileProjects] finished ...
3. log topic LABEL-STUDIO-CLIENT → status code LS trả về
4. Webhook có tới không?       → log [receive] received action=..., lsProjectId=...
   Không có log → LS chưa cấu hình webhook, hoặc bị 401 ở CurrentUserFilter
5. Project bị UNMATCHED?       → projects.template_match_status; kiểm ProjectTemplateMatcher
   UNMATCHED ⇒ project INACTIVE ⇒ task UNAVAILABLE ⇒ không bao giờ được giao
6. Reconcile ABORT?            → log "empty list from LS — aborted" hoặc "empty tasks but total=..."
```

### 21.4 Bug ở assignment ("user không nhận được task")

Đi đúng thứ tự 6 guard — mỗi guard có log riêng:

```
TaskDistributionServiceImpl.requestTask
 1. QUOTA_EXCEEDED           → SELECT COUNT(*) FROM assigned_tasks WHERE user_id=? AND status='PENDING'
 2. AUTH_PROFILE_UNAVAILABLE → auth-service có sống không? /member-profile trả gì?
 3. PROFILE_CONTEXT_BUILT    → log liệt kê fieldNames — thiếu field thì policy fail
 4. NO_ELIGIBLE_PROJECT      → ELIGIBLE_PROJECTS log có activeCount / eligibleCount
       activeCount = 0 ⇒ không project nào ACTIVE + MATCHED + chưa hết end_date
       eligibleCount = 0 ⇒ policy loại hết → xem project_assignment_policies (enabled=1)
 5. BLOCKED_BY_QUALIFICATION → campaign_qualification_configs (frozen=1, required=1)
                               + qualification_attempts (status='PASSED', đúng config_id)
 6. NO_TASK_AVAILABLE        → chạy tay findNextAssignableTaskId, bỏ dần từng điều kiện:
       - task_status IN ('AVAILABLE','IN_PROGRESS') ?
       - COUNT(assigned PENDING/ANNOTATED) < overlap ?
       - user đã nhận task này rồi ?
       - max_overlap_ratio chặn ?
```

### 21.5 Bug ở "task bị kẹt IN_PROGRESS"

```
AssignmentExpiryJob có chạy không?  → log "[AssignmentExpiryJob] Marked N assignment(s) as EXPIRED"
    ↓ nếu không: cron assignment.expiry.cron sai? job bị exception?
revertToAvailableWhereNoPending có đổi row nào không?
    ↓ điều kiện: task IN_PROGRESS + không còn PENDING nào + COUNT(ANNOTATED) < overlap
    ↓ nếu COUNT(ANNOTATED) >= overlap thì task đáng lẽ phải COMPLETED — kiểm annotation_count
```

### 21.6 Bug ở Task Import

```
task_import_jobs.status ở đâu?  → dùng ImportJobStatus để biết dừng ở bước nào
  PENDING quá lâu       → TaskImportWorkerJob có chạy không? (log [scan] dispatched N)
  QUEUED quá lâu        → instance chết; đợi reclaimStaleQueued (15 phút)
  VALIDATION_FAILED     → xem task_import_items (từng dòng + error) qua GET /task-import-jobs/{uuid}/items
  WAITING_LABEL_STUDIO_IMPORT → LS chưa xong; ls_import_id + poll timeout 600 s
  PARTIAL_FAILED        → một số item lỗi; retry chỉ gửi item chưa có ls_task_id
```

### 21.7 Bug ở tiền

```
compensation_transactions   ← sổ cái, KHÔNG BAO GIỜ SỬA TAY
user_compensation_summaries ← số dư; phải luôn = tổng hợp từ ledger
  lệch nhau ⇒ có đường ghi không đi qua CompensationLedgerWriter.apply → đó là bug
payout_requests.status + payout_attempts  → tra theo PayoutStateMachine xem transition có hợp lệ
payout_notifications                      → outbox; kẹt SENDING >? → reclaimStale
log topic COMPENSATION-LEDGER / PAYOUT-PROCESSING / PAYOUT-NOTIFICATION-JOB
```

### 21.8 Bug ở partner integration

```
integration_transaction_logs  ← BẢNG ĐẦU TIÊN. lọc theo transaction_id partner cung cấp
log topic INTEGRATION-PARTNER-FILTER:
   "Integration auth rejected: ... errorCode=PARTNER_IDENTITY_MISSING"  → token không map ra partner
   "... PARTNER_CODE_MISMATCH"                                          → gửi nhầm key
   "Integration request missing transactionId header"                   → thiếu header
   "Rejecting token: signature mismatch / alg=... not allowed"          → JwtVerifier
"auth.secret-key CHƯA cấu hình" ở startup → mọi /integration/** sẽ bị từ chối
```

---

## 22. Code Reading Roadmap

Lộ trình cho BE ~2 năm kinh nghiệm. Ước lượng: **3-4 ngày** để đọc hết Step 1-6.

### Step 1 — Bức tranh chung (2 giờ)

```
questlab-service/pom.xml                       ← stack
src/main/resources/application.yml             ← ĐỌC KỸ. Mọi hằng số nghiệp vụ nằm ở đây
src/main/resources/bootstrap.yml
com/ttt/questlab/QuestlabApplication.java
CLAUDE.md + conventions/QUESTLAB_PROJECT_ARCHITECTURE.md
docs/overview/questlab-architecture.d2         ← file này
```

**Sau bước này bạn phải trả lời được:** dùng DB gì, có Redis không, có Kafka không, có bao
nhiêu cron job và mỗi cái chạy mấy phút một lần.

### Step 2 — Mô hình dữ liệu (3 giờ)

```
entities/BaseEntity.java        ← uuid, soft delete, auditing
entities/Project.java
entities/Task.java
entities/AssignedTask.java      ← @Version + 4 cột snapshot
entities/TaskAnnotation.java
entities/Campaign.java
enums/TaskStatus.java · AssignedTaskStatus.java · ProjectStatus.java · TemplateMatchStatus.java
```

**Kiểm tra:** vẽ lại được sơ đồ `Project → Task → AssignedTask → TaskAnnotation` và nói được
`overlap` nghĩa là gì.

### Step 3 — Domain lõi: Task Assignment (1 ngày) ⭐

```
controller/AssignmentController.java
service/TaskDistributionService.java
service/impl/TaskDistributionServiceImpl.java          ← ĐỌC TỪNG DÒNG
repository/TaskRepository.java                          ← đọc kỹ javadoc + SQL
repository/AssignedTaskRepository.java
service/impl/ProjectEligibilityServiceImpl.java
assignment/policy/AssignmentPolicyEvaluatorImpl.java
job/AssignmentExpiryJob.java
docs/services/task-assignment.md + .d2
docs/flows/01-request-task.d2
```

**Kiểm tra:** giải thích được vì sao `FOR UPDATE` giải quyết được race hai user cùng xin task.

### Step 4 — Label Studio (1 ngày) ⭐

```
webhook/LsWebhookController.java
service/impl/SyncServiceImpl.java                       ← 605 dòng, đọc hết
job/ReconciliationJob.java
client/LabelStudioClient.java
config/RestTemplateConfig.java                          ← javadoc rất đáng đọc
service/impl/AnnotationServiceImpl.java
service/impl/MediaSigningServiceImpl.java + MediaServiceImpl.java
docs/services/label-studio.md + .d2
```

**Kiểm tra:** nói được Source of Truth của từng loại dữ liệu, và vì sao cần cả webhook lẫn
reconcile.

### Step 5 — Cross-cutting (nửa ngày)

```
config/CurrentUserFilter.java + CurrentUserContext.java
client/AuthClient.java
exception/GlobalExceptionHandler.java                   ← nhớ: luôn trả HTTP 200
config/AsyncConfig.java
config/JpaAuditConfig.java + AuditorProvider.java
conventions/CODING_CONVENTIONS.md
```

### Step 6 — Concurrency & tiền (nửa ngày) ⭐

```
service/compensation/CompensationLedgerWriter.java      ← MẪU THIẾT KẾ ĐÁNG HỌC NHẤT
service/compensation/impl/EarningIngressServiceImpl.java ← idempotency
service/payout/PayoutStateMachine.java                   ← state machine + monetary effect
service/payout/impl/PayoutProcessingServiceImpl.java     ← thứ tự khoá
enums/taskimport/ImportJobStatus.java                    ← canTransitionTo
job/taskimport/TaskImportWorkerJob.java                  ← claimStatus (compare-and-set)
```

### Step 7 — Đọc khi cần (theo ticket)

```
service/taskimport/**        ← nhận ticket về import
service/qualification/**     ← nhận ticket về sát hạch
service/integration/**       ← nhận ticket về partner SDK
service/impl/TaskRecommendationServiceImpl.java  ← nhận ticket về Home
validation/**                ← nhận ticket về validate annotation
template/**                  ← nhận ticket về template mới
```

### Step 8 — Chạy thử

```
1. Cần: MariaDB + Redis + Label Studio (hoặc mock) + auth-service
2. CONFIG_SERVER_URI phải trỏ tới Config Server (bootstrap.yml yêu cầu)
3. Chạy migration db/migration/*.sql theo thứ tự V2 → V37
4. mvn spring-boot:run
5. Mở http://localhost:9090/swagger-ui/index.html
Chi tiết: conventions/QUESTLAB_ENV-SETUP.md
```

---

## 23. Nơi cần sửa khi nhận feature

| Loại ticket | File cần đụng tới |
|---|---|
| Thêm điều kiện phân phối task | `TaskRepository.findNextAssignableTaskId` (+ 3 query song sinh: `findRecommendableTaskIds`, `lockRecommendedTaskForUser`, `findNextAvailableTaskIdOutsideGatedCampaigns`) — **phải sửa cả 4 nếu không sẽ lệch hành vi** |
| Thêm field vào policy eligibility | `enums/ConditionDataType`, `ConditionOperator`, `assignment/policy/AssignmentPolicyCompiler`, `AssignmentPolicyValidator`, `AssignmentPolicyEvaluatorImpl`, `AssignmentProfileContextBuilderImpl`, seed `assignment_condition_definitions` |
| Hỗ trợ template gán nhãn mới | `template/normalize/TemplateNormalizer`, `template/match/ProjectTemplateMatcher`, `validation/type/*`, seed `annotation_templates` |
| Thêm format file import | `enums/taskimport/ImportFormat`, `service/taskimport/parser/`, `registry/SupportedFileTypeRegistry`, `application.yml` → `task-import.formats.allowed` |
| Thêm provider storage | `enums/taskimport/external/ExternalProviderType`, `service/taskimport/external/provider/` (implement `ExternalStorageProvider`), `ExternalStorageProviderRegistry` |
| Thêm loại bút toán | `enums/compensation/CompensationTransactionType`, `CompensationLedgerWriter.applyToSummary` |
| Thêm transition payout | `service/payout/PayoutStateMachine.buildTransitions` (**chỉ ở đây**) |
| Thêm endpoint partner | `IntegrationController`, `ServicePermissionCode`, đăng ký `auth_external_api.code` bên auth-service |
| Thêm cron job | `job/`, khai property cron trong `application.yml` |
| Thêm mã lỗi | `config/constants/*ErrorCode.java` |
| Đổi hằng số nghiệp vụ | `application.yml` (đa số **không** hardcode trong Java) |

---

# Backend Knowledge Priority

## 🔴 MUST UNDERSTAND — không hiểu thì không làm được Questlab

1. **Mô hình dữ liệu lõi** — `Project → Task → AssignedTask → TaskAnnotation`, ý nghĩa của
   `overlap`, và 4 trạng thái của `AssignedTaskStatus` / `TaskStatus`.
2. **Luồng `POST /assignments/request`** — 8 bước, mỗi bước từ chối vì lý do gì.
3. **`FOR UPDATE` trong `findNextAssignableTaskId`** — vì sao cần, và cơ chế current read của
   InnoDB.
4. **Vòng đời assignment**: `PENDING → ANNOTATED | EXPIRED | CANCELLED`, và
   `AssignmentExpiryJob` trả task về pool ra sao.
5. **Label Studio là Source of Truth của cái gì, Questlab của cái gì.**
6. **Webhook + Reconciliation** — vì sao phải có cả hai.
7. **Template gate** — `label_config` không khớp ⇒ project INACTIVE ⇒ task không bao giờ được giao.
8. **Soft delete** — mọi query phải kèm `is_deleted = false AND ls_deleted = false`.
9. **GlobalExceptionHandler trả HTTP 200** — mã lỗi nằm trong body.
10. **Xác thực**: Questlab không tự authenticate; identity đến từ gateway + auth-service;
    `CurrentUserFilter` set ThreadLocal.
11. **`application.yml` là nguồn của mọi hằng số nghiệp vụ** — đọc trước khi đoán.

## 🟡 SHOULD UNDERSTAND — cần để debug và phát triển tốt

12. **Assignment Policy** — compile → validate → canonicalize → hash → evaluate; snapshot lưu
    trong `assigned_tasks`.
13. **Qualification gate** — freeze config, PASS gắn với `qualificationConfigId`.
14. **Ba mô hình idempotency** trong project (UNIQUE key, pessimistic lock, compare-and-set).
15. **`CompensationLedgerWriter`** — điểm ghi duy nhất, 4 bất biến.
16. **`PayoutStateMachine`** — transition gắn với `MonetaryEffect`, thứ tự khoá chống deadlock.
17. **`ImportJobStatus.canTransitionTo`** + `claimStatus` — cách chống chạy trùng giữa replica.
18. **Redis trong Questlab** — chỉ cho recommendation, degrade được.
19. **`RestTemplateConfig`** — pool, retry, evict idle; và vì sao POST chỉ retry trên
    `NoHttpResponseException`.
20. **Signed URL media** — HMAC gắn với `userId`, không rò token LS khi redirect sang S3.
21. **`@Async("lsSyncExecutor")` + `CallerRunsPolicy`** — đánh đổi khi burst.
22. **Partner integration** — 2 chế độ user (định danh / vãng lai), `transactionId` bắt buộc.

## 🟢 NICE TO KNOW — học sau

23. Chi tiết `validation/**` (từng loại control của Label Studio).
24. Chi tiết `service/taskimport/external/**` (manifest, archive, crypto, portal).
25. `MatchingEngine` / `MatchingScoreServiceImpl` và block `matching.criteria` trong config.
26. Question Bank (`/questions`, `/question-sets`) và project `SURVEY`.
27. Dashboard project (`/projects/{id}/dashboard`, `DashboardChart`, `DashboardWarningCode`).
28. GitLab CI + Helm GitOps.
29. Eureka / Spring Boot Admin (hiện gần như không dùng).
30. `tools/graphify` — script sinh bản đồ quan hệ code.

---

# Interview Preparation

## Explain Questlab in 2 minutes

> "Questlab là backend của một nền tảng **crowdsourcing gán nhãn dữ liệu**. Bài toán là: có
> hàng trăm nghìn ảnh/văn bản cần gán nhãn, và có hàng nghìn người dùng ngoài muốn nhận việc
> để kiếm tiền. Công cụ gán nhãn thì đã có sẵn — **Label Studio**, một sản phẩm open-source —
> nhưng nó chỉ phục vụ một đội annotator nội bộ. Questlab là **lớp điều phối** đặt phía trước
> nó.
>
> Về kiến trúc, đây là một Spring Boot 3.3 monolith, Java 17, MariaDB, phân lớp
> Controller → Service → Repository, khoảng 170 endpoint và 47 bảng. Nó nằm trong một hệ
> microservice cùng auth-service, notification-service, file-service, tất cả sau một API
> Gateway.
>
> Nghiệp vụ trung tâm là **phân phối task**. Khi user bấm 'nhận việc', backend chạy 8 bước
> trong một transaction: kiểm quota, lấy profile từ auth-service, đánh giá *Assignment Policy*
> của từng project, kiểm *qualification gate* — user đã thi đậu bài sát hạch của campaign chưa
> — rồi mới chạy một câu native SQL để chọn task. Câu SQL đó là phần đáng nói nhất: nó phải
> đảm bảo task còn suất `overlap` (mỗi task cần N người *khác nhau* làm độc lập để đo đồng
> thuận), user chưa từng làm task đó, và không vượt `max_overlap_ratio` — tức không để hai
> người luôn bị ghép cùng nhau. Cuối câu là `LIMIT 1 FOR UPDATE`: đây là cách chống race khi
> hai user bấm cùng lúc. Row `tasks` bị khoá, transaction thứ hai chờ, và khi được đánh thức
> InnoDB dùng *current read* nên nó đọc lại `assigned_tasks` với dữ liệu mới và tự loại task
> đã hết suất.
>
> Với Label Studio, Questlab đồng bộ **hai chiều bằng hai kênh**: webhook cho tốc độ, và một
> reconciliation job chạy 3 phút một lần làm lưới an toàn — vì webhook có thể mất khi LS
> restart. Reconcile có safety check khá tinh: nếu LS trả về danh sách rỗng thì **không** coi
> là 'đã xoá hết' mà dừng lại, tránh xoá sạch mirror vì một sự cố tạm thời.
>
> Ngoài ra hệ thống còn có module nhập dữ liệu từ Portal/S3/MinIO/SFTP theo lịch, và một module
> tiền công viết theo mô hình **ledger**: một sổ cái bất biến với `idempotency_key` UNIQUE, một
> bảng số dư được khoá `PESSIMISTIC_WRITE` trước mỗi lần ghi, và một state machine cho quy
> trình chi tiền trong đó mỗi transition gắn cứng với hiệu ứng tiền của nó — để không có đường
> nào đổi trạng thái mà quên phần tiền."

---

## Possible Interview Questions

### Architecture

1. Questlab và Label Studio phân chia trách nhiệm thế nào? Cái gì là Source of Truth của cái gì?
2. Vì sao Questlab phải mirror project/task của Label Studio thay vì gọi thẳng LS mỗi lần?
3. Tại sao cần **cả** webhook lẫn reconciliation job? Chỉ một cái có được không?
4. `SyncServiceImpl.reconcileProjects` có safety check "LS trả rỗng thì abort". Vì sao? Ở
   `reconcileTasksForProject` safety check lại khác — khác thế nào và tại sao?
5. Template gate là gì? Một project LS không khớp template thì điều gì xảy ra?
6. Vì sao logic phân phối được tách ra package `assignment/` thay vì nằm trong `service/`?
7. Hệ thống là monolith. Nếu phải tách microservice, bạn tách theo đường nào?

### Database

8. Vì sao API chỉ nhận/trả `uuid` mà không dùng `id` tự tăng?
9. `is_deleted` và `ls_deleted` khác nhau thế nào? Quên điều kiện nào thì sinh bug gì?
10. Codebase không dùng `@ManyToOne`/`@OneToMany` mà lưu id thô rồi join tay. Được gì, mất gì?
11. `tasks.project_id` không có FK. Điều đó gây ra sự cố gì trong luồng partner, và source fix
    bằng cách nào?
12. Migration chạy tay, không có Flyway. Rủi ro là gì? Bạn sẽ cải thiện thế nào?
13. `AssignedTask` có 4 cột snapshot (`profile_context_json`, `matched_policy_version`,
    `matched_policy_hash`, `match_reason_json`). Vì sao cần?

### Transaction & Concurrency ⭐

14. **Hai user cùng bấm "nhận việc" tại một thời điểm. Hệ thống chống trùng task bằng cách
    nào?** Giải thích vai trò của `FOR UPDATE` và current read của InnoDB.
15. Khoá đặt trên row `tasks`, nhưng điều kiện overlap lại đếm trên `assigned_tasks`. Vì sao
    vẫn đúng?
16. `AssignedTask` có `@Version`. Optimistic lock ở đây bảo vệ tình huống nào?
17. `AnnotationServiceImpl.createAnnotation` gọi HTTP tới Label Studio **bên trong**
    `@Transactional`. Hệ quả là gì? Bạn sẽ sửa thế nào?
18. Kể ba mô hình idempotency khác nhau trong codebase này và tình huống nào dùng cái nào.
19. `EarningIngressServiceImpl.recordEarning` **cố ý không có** `@Transactional`. Vì sao?
20. `CompensationLedgerWriter.apply` dùng `saveAndFlush` chứ không `save`. Vì sao?
21. `PayoutProcessingServiceImpl` khoá request trước, summary sau. Nếu đảo thứ tự thì sao?
22. `ImportJobStatus.canTransitionTo` trả `false` khi trạng thái hiện tại là terminal. Bug gì
    được ngăn?
23. Nhiều replica cùng chạy `TaskImportWorkerJob`. Làm sao một job không bị xử lý hai lần?
24. Instance chết ngay sau khi claim job. Hệ thống phục hồi thế nào?
25. `RecommendedTaskAssignmentServiceImpl.revalidateAndAssign` là `@Transactional protected` và
    được gọi từ `assign()` cùng class. Có vấn đề gì không?

### REST API

26. Vì sao `GlobalExceptionHandler` đặt `@ResponseStatus(HttpStatus.OK)` cho mọi handler? Đánh
    đổi là gì?
27. `TaskController` tự parse `sort`/`order` thủ công thay vì để Spring bind vào enum. Vì sao?
28. `AssignedTaskRepository.findPageByProjectIdAndUserIdAndStatus` cố ý **không có** `ORDER BY`.
    Tại sao, và caller (`TaskServiceImpl.buildMyAssignedSort`) phải làm gì?
    *(hỏi thêm)* Biến thể sort theo `STATUS` viết `CASE` thẳng trong JPQL thay vì
    `Sort.by("status")` — vì sao?

### Label Studio

29. User submit annotation: Questlab ghi vào LS trước hay ghi local trước? Vì sao thứ tự đó?
30. `MediaController` proxy file của LS. Signed URL được tạo thế nào và bảo vệ được gì?
31. Khi LS redirect 303 sang S3, `MediaServiceImpl` xử lý header `Authorization` thế nào và vì
    sao?
32. `RestTemplateConfig` có 3 lớp chống `NoHttpResponseException`. Kể ra. Vì sao POST chỉ retry
    trên `NoHttpResponseException`?

### Scheduler

33. Liệt kê các job và nhịp chạy. Job nào tắt mặc định?
34. `AssignmentExpiryJob` đọc `findDistinctUserIdsPendingExpiredBefore` **trước** khi
    `markExpiredBefore`. Vì sao không đổi thứ tự?
35. `PayoutNotificationDispatchJob` nuốt `RuntimeException`. Đó là bug hay chủ ý?
36. Chạy 3 replica thì `ReconciliationJob` chạy mấy lần? Có vấn đề không?

### Redis

37. Redis dùng cho việc gì trong Questlab? Có dùng làm distributed lock không?
38. Watchlist dùng Redis **Hash** thay vì List/Set. Vì sao?
39. Redis chết thì tính năng nào hỏng, tính năng nào vẫn chạy?
40. Cache recommendation có `schemaVersion`. Giải quyết vấn đề gì khi deploy?
41. Người dùng bấm vào task được gợi ý nhưng người khác đã lấy mất. Hệ thống phản hồi thế nào?

### Messaging

42. Questlab có dùng Kafka không? Nếu không, những nhu cầu bất đồng bộ được giải quyết bằng gì?
43. `payout_notifications` là mẫu thiết kế gì? Nó bảo đảm điều gì mà `@Async` không bảo đảm được?

### Security

44. Questlab tự xác thực hay nhận identity từ nơi khác? Mô tả chuỗi.
45. `AuthClient.extractSub` không kiểm chữ ký JWT. Vì sao chấp nhận được, và hai điều kiện hạ
    tầng nào phải đúng?
46. `JwtVerifier` chỉ cho phép đúng một thuật toán `HS256`. Chặn được hai lớp tấn công nào?
47. Vì sao `/integration/` nằm trong WHITE_LIST của `CurrentUserFilter`?
48. `PartnerContext` là ThreadLocal. Không `clear()` thì hậu quả gì?
49. Vì sao header `transactionId` là **bắt buộc** với `/integration/**`?

### Business logic

50. `overlap` nghĩa là gì? `max_overlap_ratio` giải quyết vấn đề gì khác với `overlap`?
51. Query chọn task sắp xếp `IN_PROGRESS` trước `AVAILABLE`. Lý do nghiệp vụ?
52. Vì sao `approveCampaign` **và** `activateCampaign` đều gọi `freezeForGoLive`?
53. Một user đã PASS bài sát hạch, admin sửa cấu hình test rồi freeze lại. User có phải thi lại
    không? Vì sao?
54. `QualificationAttemptExpiryJob` giải quyết vấn đề gì mà nếu thiếu sẽ khoá vĩnh viễn user?
55. Partner dùng "pool user" chung. Rủi ro nghiệp vụ là gì, và query chống bằng cách nào?

### Scaling & Failure handling

56. Điểm nghẽn đầu tiên khi lượng user tăng 10 lần là gì? (Gợi ý: correlated subquery 3 tầng +
    `FOR UPDATE` trên cùng dải `t.id ASC`.)
57. `ORDER BY t.id ASC LIMIT 1 FOR UPDATE` khiến mọi request tranh cùng vài row đầu. Bạn cải
    thiện thế nào?
58. `ReconciliationJob` gọi LS tuần tự cho từng project. Với 1 000 project thì sao? Cách sửa?
59. auth-service chết. Những API nào hỏng, những API nào vẫn chạy?
60. Label Studio chết 30 phút. Điều gì xảy ra với `POST /annotations`, với reconcile, với
    `POST /assignments/request`?
61. `lsSyncExecutor` dùng `CallerRunsPolicy`. Khi burst webhook thì hành vi thế nào? Đánh đổi?
62. Nếu phải thêm distributed lock cho scheduler khi scale nhiều replica, bạn dùng gì và đặt ở
    đâu?

### Câu hỏi mở

63. Đọc `CompensationLedgerWriter` và `PayoutStateMachine`, bạn thấy pattern gì đáng học? Áp
    dụng lại ở đâu trong hệ thống này?
64. Nếu được refactor một chỗ duy nhất trong codebase, bạn chọn chỗ nào và vì sao?

---

## Phụ lục — Những điều CHƯA đủ evidence để kết luận

Ghi lại trung thực để người đọc không hiểu nhầm là đã xác minh:

1. **Webhook của Label Studio chưa được verify chữ ký.** `application.yml` có
   `label-studio.webhook.secret` nhưng `LabelStudioProperties` không có field tương ứng, và
   `LsWebhookController` không đọc header chữ ký nào (javadoc ghi
   `[SECURITY REVIEW REQUIRED]` + `[VERIFY: actual signature header name]`). **Chưa đủ evidence
   trong source để kết luận** Label Studio được cấu hình gửi JWT thế nào để qua được
   `CurrentUserFilter`.
2. **`EarningIngressService` chưa có caller.** Grep toàn repo chỉ thấy nó trong chính package
   `service/compensation/**`. `AnnotationServiceImpl` không inject nó. **Chưa đủ evidence trong
   source để kết luận** earning được ghi vào ledger bằng đường nào.
3. **Cấu hình Kubernetes.** Không có `helm/`, `k8s/`, `deploy/` trong repo. Replica, resource
   limit, probe, ingress nằm ở repo `questlab-core-helm-repo` — **chưa đủ evidence trong source
   để kết luận**.
4. **Chống chạy song song của `ExternalStorageSchedulerTick` giữa nhiều replica.** Chỉ thấy
   guard `SKIPPED_ALREADY_RUNNING` ở tầng run, không thấy distributed lock ở tầng tick.
5. **`spring.boot.admin.client`, Eureka** — có cấu hình nhưng `registerWithEureka: false` và
   `fetchRegistry: false`; mức độ thực sự được dùng trong vận hành **chưa đủ evidence trong
   source để kết luận**.

---

*Tài liệu này được dựng bằng cách đọc source `questlab-service` (702 file Java, 107 file test,
37 migration SQL) cùng `pom.xml` của 4 repo trong workspace. Mọi con số và tên class là thật.*
