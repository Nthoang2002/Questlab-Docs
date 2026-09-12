# Questlab Backend — Tài liệu onboarding

Tài liệu được dựng bằng cách **đọc source thực tế** của `questlab-service`
(702 file Java, 107 file test, 37 migration SQL) và `pom.xml` của cả 4 repo trong workspace.
Mọi tên class, tên bảng, tên property đều là thật; kết luận quan trọng đều có mục **Evidence**.
Chỗ nào chưa đủ căn cứ thì ghi rõ *"Chưa đủ evidence trong source để kết luận"*.

Tất cả file `.d2` đã được **compile thành công bằng `d2 v0.8.2`** — dán thẳng vào
<https://play.d2lang.com/> là render được.

---

## Bắt đầu từ đâu

| Bạn là… | Đọc theo thứ tự này |
|---|---|
| **Dev mới vào team** | `overview/questlab-backend-overview.md` §1→§6 → `overview/questlab-architecture.d2` → §22 Code Reading Roadmap |
| **Đang debug một bug** | `overview/questlab-backend-overview.md` §21 Debugging Guide |
| **Nhận ticket mới** | `overview/questlab-backend-overview.md` §23 "Nơi cần sửa khi nhận feature" → doc domain tương ứng |
| **Chuẩn bị phỏng vấn** | Toàn bộ overview → phần *Interview Preparation* ở cuối |
| **Muốn hiểu 1 flow cụ thể** | `flows/main-business-flows.md` + file `.d2` tương ứng |

---

## Cấu trúc

```
docs/
├── README.md                              ← file này
│
├── overview/
│   ├── questlab-backend-overview.md       ★ TÀI LIỆU CHÍNH (23 mục + knowledge priority + 64 câu phỏng vấn)
│   └── questlab-architecture.d2           ★ KIẾN TRÚC TỔNG (4 tầng)
│
├── services/                              ← từng business domain
│   ├── task-assignment.md / .d2           ⭐ domain lõi — đọc đầu tiên
│   ├── label-studio.md / .d2              ⭐ tích hợp quan trọng nhất
│   ├── project-campaign.md / .d2
│   ├── qualification.md / .d2
│   ├── task-import.md / .d2               ← domain lớn nhất về số file
│   ├── compensation-payout.md / .d2       ⭐ code chất lượng cao nhất, đáng học
│   ├── partner-integration.md / .d2
│   └── recommendation.md / .d2            ← nơi DUY NHẤT dùng Redis
│
└── flows/
    ├── main-business-flows.md             ← 10 flow, trace đầy đủ Controller→Service→Repo→DB→External
    ├── 01-request-task.d2                 ⭐
    ├── 02-submit-annotation.d2
    ├── 03-label-studio-webhook.d2
    ├── 04-reconciliation.d2
    ├── 05-assignment-expiry.d2
    ├── 06-task-import-async.d2
    ├── 07-external-storage-import.d2
    ├── 08-payout-request-to-paid.d2
    ├── 09-partner-sdk.d2
    └── 10-media-signed-url.d2
```

---

## Tóm tắt 60 giây

**Questlab = nền tảng crowdsourcing gán nhãn dữ liệu.** Label Studio làm trình soạn nhãn;
Questlab làm lớp điều phối nhân lực phía trước nó.

| | |
|---|---|
| Stack | Java 17 · Spring Boot **3.3.2** · Spring Cloud 2023.0.3 · Maven |
| DB | **MariaDB** (`questlab_data`), 47 entity, `ddl-auto: none`, 37 migration SQL chạy tay |
| Redis | **CÓ** — nhưng chỉ cho Home recommendation; degrade được |
| Kafka / RabbitMQ | **KHÔNG** trong questlab-service (Kafka nằm ở `notification-service`) |
| Feign | **KHÔNG** — dùng `RestTemplate` + Apache HttpClient5 |
| Spring Security | **KHÔNG** — filter thủ công + `AuthClient` |
| API | ~171 endpoint, response luôn HTTP **200**, mã lỗi trong body |
| Scheduler | **9** job `@Scheduled` |
| External | Label Studio · auth-service · notification-service · file-service · S3/MinIO · SFTP |
| Deploy | Dockerfile → GitLab CI → image registry → sed `values.yaml` của Helm repo → GitOps K8s |

**3 điều dễ sai nhất khi mới vào:**
1. HTTP status **luôn 200** — nhìn `body.status` / `body.httpCode`, không nhìn status line.
2. Mọi query nghiệp vụ phải kèm `is_deleted = false AND ls_deleted = false`.
3. Hằng số nghiệp vụ (cron, quota, TTL, giới hạn file) nằm ở **`application.yml`**, không
   hardcode trong Java — đọc file đó trước khi đoán.

---

## Tài liệu gốc trong repo `questlab-service`

Đây là tài liệu **onboarding tổng hợp**. Khi làm ticket cụ thể, đọc thêm:

| File | Nội dung |
|---|---|
| `questlab-service/CLAUDE.md` | Team knowledge base + lịch sử version |
| `questlab-service/conventions/CODING_CONVENTIONS.md` | Quy ước code |
| `questlab-service/conventions/QUESTLAB_PROJECT_ARCHITECTURE.md` | Hub component + layer dependency |
| `questlab-service/conventions/QUESTLAB_ENV-SETUP.md` | Dựng môi trường local |
| `questlab-service/conventions/TASK_DISTRIBUTION_DESIGN.md` | Thiết kế phân phối task |
| `questlab-service/conventions/SIGNED_URL_DESIGN.md` | Thiết kế signed URL |
| `questlab-service/requirement/TASK_ASSIGNMENT_REQURIREMENT.MD` | Requirement gốc |
| `questlab-service/docs/*.md` | Requirement từng feature (task import, external storage, recommendation, payout…) |
| `questlab-service/tools/graphify/out/graph.html` | Bản đồ quan hệ code sinh tự động |
