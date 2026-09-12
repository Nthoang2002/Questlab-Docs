# Domain: Project, Campaign & Reward

---

## 1. Purpose

- **Project** = một "lô việc gán nhãn" — tương ứng 1 project bên Label Studio (trừ project
  `SURVEY`). Chứa `label_config`, `overlap`, `end_date`, `price`.
- **Campaign** = một **chiến dịch** gói nhiều project lại, gắn phần thưởng, có thời hạn,
  có thể yêu cầu bài test đầu vào (qualification), và có thể công khai cho user chọn tham gia.
- **Reward** = phần thưởng gắn vào campaign.

Quan hệ: `Campaign ──(N:N qua campaign_projects)── Project`,
`Campaign ──(N:N qua campaign_rewards)── Reward`.

---

## 2. Entry points

### Project — `ProjectController` (`/projects`)

| Method | Endpoint | Mục đích |
|---|---|---|
| POST | `/projects` | Tạo project (tạo luôn trên LS, hoặc SURVEY thì chỉ local) |
| GET | `/projects` , `/projects/filter` | Danh sách |
| GET | `/projects/{projectId}` | Chi tiết |
| PUT | `/projects/{projectId}` | Sửa (đẩy sang LS) |
| PUT | `/projects/{projectId}/overlap` | Đổi overlap |
| PUT | `/projects/{id}/activate` \| `/deactivate` \| `/archived` | Đổi vòng đời |
| DELETE | `/projects/{projectId}` | Xoá mềm |
| GET | `/projects/{projectId}/dashboard` | Số liệu thống kê project |
| GET | `/projects/discover` | Khám phá project cho user |
| GET | `/projects/contributed` | Project tôi đã tham gia |
| GET/PUT/DELETE | `/projects/{projectUuid}/assignment-policy` | CRUD policy eligibility |

### Campaign — `CampaignController` (`/campaigns`)

| Method | Endpoint | Mục đích |
|---|---|---|
| POST | `/campaigns` | Tạo (status `DRAFT`) |
| GET | `/campaigns` , `/campaigns/public` | Danh sách (admin / công khai) |
| PUT | `/campaigns/{id}` | Sửa |
| POST | `/campaigns/{id}/approve` | `DRAFT → ACTIVE` + **freeze qualification pool** |
| POST | `/campaigns/{id}/deactivate` | `ACTIVE → INACTIVE` |
| POST | `/campaigns/{id}/activate` | `INACTIVE → ACTIVE` + **freeze lại** |
| PUT | `/campaigns/{id}/publish` \| `/unpublish` | Bật/tắt hiển thị ở `/campaigns/public` |
| DELETE | `/campaigns/{id}` | Xoá |
| POST/DELETE | `/campaigns/{id}/projects/{projectId}` | Link/unlink project |
| POST/DELETE | `/campaigns/{id}/rewards/{rewardId}` | Link/unlink reward |

**Evidence:** `controller/ProjectController.java`, `controller/CampaignController.java`

---

## 3. Business logic

```
ProjectController → ProjectService → ProjectServiceImpl (908 dòng — service lớn nhất)
    ├── ProjectRepository
    ├── LabelStudioClient        (createNewProject / updateProject / getProjectById)
    ├── TaskRepository           (bulkUpdateStatusByProjectId, bulkMarkDeletedByProjectId)
    ├── AssignedTaskRepository
    └── ProjectTemplateMatcher

CampaignController → CampaignService → CampaignServiceImpl
    ├── CampaignRepository / CampaignProjectRepository / CampaignRewardRepository
    ├── QualificationPoolService     (freezeForGoLive)
    └── CampaignNotificationService  → NotificationClient → notification-service
```

---

## 4. Persistence

| Entity | Table | Ghi chú |
|---|---|---|
| `Project` | `projects` | `ls_project_id` **unique, NULL với SURVEY**; `template_match_status`; `project_status`; `overlap`; `max_overlap_ratio`; `question_set_id` (bắt buộc với SURVEY) |
| `Campaign` | `campaigns` | `status` ∈ DRAFT/ACTIVE/INACTIVE/COMPLETED/CLOSED; `is_public` **độc lập với status**; `start_date`/`end_date` |
| `CampaignProject` | `campaign_projects` | bảng nối |
| `CampaignReward` | `campaign_rewards` | bảng nối |
| `Reward` | `rewards` | |
| `AnnotationTemplate` | `annotation_templates` | danh mục template được hỗ trợ |

### Hai loại project — `ProjectType`

| | `LABELING` | `SURVEY` |
|---|---|---|
| Tồn tại trên LS | ✅ | ❌ (`ls_project_id = NULL`) |
| Nguồn nội dung | `label_config` XML | `question_set_id` → `question_sets` |
| Lưu ý code | mọi code path đi ra LS **phải null-check `lsProjectId`** | |

> Javadoc của `Project.lsProjectId` ghi rõ: *"NULL với project SURVEY — loại này không được tạo
> trên LS (quyết định D1 của RS2-10034), nên mọi code path đi ra LS phải kiểm tra null trước khi
> dùng."*

---

## 5. Integration

| Hệ thống | Khi nào |
|---|---|
| **Label Studio** | Tạo/sửa project `LABELING`; đọc metadata |
| **notification-service** | `CampaignNotificationServiceImpl` → `NotificationClient` gửi push/mail khi campaign được approve |

---

## 6. Background processing

| Job | Cron | Làm gì |
|---|---|---|
| `CampaignExpiryJob` | `campaign.expiry.cron` = `0 0 1 * * *` (1h sáng hằng ngày) | `campaignRepository.closeExpiredCampaigns(LocalDate.now())` — đóng campaign quá `end_date` |

**Evidence:** `job/CampaignExpiryJob.java`

---

## 7. Important flows

### 7.1 Campaign lifecycle

```
     createCampaign
          ↓
       DRAFT ──approve──► ACTIVE ──deactivate──► INACTIVE
                            │                        │
                            │                        └──activate──► ACTIVE
                            │
                    CampaignExpiryJob (quá end_date)
                            ↓
                         CLOSED
```

Guard trạng thái rất chặt trong `CampaignServiceImpl`:

- `approveCampaign` — chỉ chạy khi `status == DRAFT`, ngược lại
  `BadRequestException(CampaignErrorCode.NOT_DRAFT)`.
- `deactivateCampaign` — chỉ khi `ACTIVE` (`NOT_ACTIVE`).
- `activateCampaign` — chỉ khi `INACTIVE` (`NOT_INACTIVE`).

**Điểm nghiệp vụ quan trọng:** cả `approve` và `activate` đều gọi
`qualificationPoolService.freezeForGoLive(campaign)`. Freeze = chốt lại bộ đề thi tại thời
điểm campaign lên sóng. Comment trong source giải thích vì sao `activate` cũng phải freeze:
bộ câu hỏi có thể đã bị đổi trong lúc campaign nằm `INACTIVE`.

**Evidence:** `service/impl/CampaignServiceImpl.java:182-233`

### 7.2 `is_public` tách rời `status`

Javadoc `Campaign.isPublic`: *"Independent of status — gates visibility on
`GET /campaigns/public` only."*
`GET /campaigns/public` lọc `isPublic = true AND status = ACTIVE`. Nghĩa là admin có thể
approve campaign (chạy thật) mà chưa cho hiển thị công khai, và ngược lại.

### 7.3 Project → có được phân phối task không?

Chỉ khi **cả 3** đúng:

```
projects.project_status      = ACTIVE
projects.template_match_status = MATCHED
projects.end_date            >= now          ← findActiveAssignableProjects(status, matchStatus, now)
```

Cộng thêm `ProjectAssignmentPolicy` (nếu có bản `enabled`) và qualification gate.

---

## 8. Risk

- **`tasks.project_id` không có FK.** Javadoc của
  `TaskRepository.findNextAvailableTaskIdOutsideGatedCampaigns` nói rõ: project bị xoá cứng
  để lại task mồ côi, và vì `ORDER BY t.id ASC` luôn chọn id nhỏ nhất, luồng partner sẽ vấp
  đúng dòng hỏng ở **mọi** lần gọi. Đó là lý do query đó phải `JOIN projects`.
- **`ls_project_id` unique** — nếu LS tái sử dụng id (không xảy ra trong thực tế) sẽ va chạm.
- **Xoá project là xoá mềm** (`is_deleted`, `ls_deleted`); mọi query nghiệp vụ đều phải kèm
  `is_deleted = false AND ls_deleted = false`. Quên điều kiện này là lớp bug phổ biến nhất
  của codebase.

---

## 9. Diagram

Xem `project-campaign.d2`.
