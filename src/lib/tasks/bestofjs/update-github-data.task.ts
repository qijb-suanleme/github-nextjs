import { schema } from "@/drizzle/database";
import { eq, not } from "drizzle-orm";
import { SnapshotsService } from "@/drizzle/snapshots";
import { createTask } from "@/lib/tasks/task-runner";
import { createGitHubClient } from "@/lib/github/github-api-client";
import { aliyunOSSClient } from "@/lib/oss/aliyun-oss";
import { translator } from "@/lib/translate/translator";
import { createRepoWebhookRequest } from "@/lib/webhook/repo-webhook-schema";
import { sendWebhookToMultipleUrls } from "@/lib/shared/webhook-utils";

export const updateGitHubDataTask = createTask({
  name: "update-github-data",
  description:
    "Update GitHub data for all repos, process assets (icons, translations, Open Graph images), and send webhook callbacks. To be run every day",
  run: async ({ db, processRepos, logger }) => {
    const client = createGitHubClient();
    const snapshotsService = new SnapshotsService(db);

    return await processRepos(
      async (repo) => {
        const startTime = Date.now();
        logger.debug(`开始处理仓库: ${repo.full_name}`);

        const updateData: any = {};
        const processingStatus = {
          icon_processed: false,
          description_translated: false,
          readme_translated: false,
          og_image_processed: false,
          release_note_translated: false,
        };

        try {
          logger.debug("STEP 1: 获取GitHub API数据");
          const githubData = await client.fetchRepoInfo(repo.full_name);
          logger.debug(githubData);
          
          if (githubData.archived) {
            logger.warn(`仓库 ${repo.full_name} 已归档`);
          }
          
          const { full_name, stargazers_count: stars } = githubData;

          logger.debug("STEP 2: 获取贡献者数量");
          const contributor_count = await client.fetchContributorCount(full_name);
          logger.debug("贡献者数据", { contributor_count });

          logger.debug("STEP 3: 获取README内容");
          const readmeContent = await client.fetchRepoReadMeAsMarkdown(full_name);
          logger.debug("README内容获取完成", { 
            hasReadme: !!readmeContent, 
            readmeLength: readmeContent?.length || 0 
          });

          // 处理图标上传
          if (!repo.icon_url) {
            logger.debug("STEP 4: 下载并上传仓库图标");
            try {
              const iconUrl = `https://avatars.githubusercontent.com/u/${repo.owner_id}?v=3&s=100`;
              const ossPath = aliyunOSSClient.generateOSSPath('icon', repo.full_name, 'icon.png');
              const uploadedIconUrl = await aliyunOSSClient.uploadFromUrl(iconUrl, ossPath);
              updateData.icon_url = uploadedIconUrl;
              processingStatus.icon_processed = true;
              logger.debug("图标上传成功", { iconUrl: uploadedIconUrl });
            } catch (error) {
              logger.error("图标上传失败:", error);
            }
          } else {
            processingStatus.icon_processed = true;
          }

          // 翻译描述
          if (githubData.description) {
            logger.debug("STEP 5: 翻译项目描述");
            try {
              const translatedDescription = await translator.translateDescription(githubData.description);
              updateData.description_zh = translatedDescription;
              processingStatus.description_translated = true;
              logger.debug("描述翻译完成", {
                original: githubData.description.substring(0, 50) + "...",
                translated: translatedDescription.substring(0, 50) + "..."
              });
            } catch (error) {
              logger.error("描述翻译失败:", error);
            }
          }

          // 处理README翻译
          if (readmeContent) {
            logger.debug("STEP 6: 翻译README内容");
            try {
              const translatedReadme = await translator.translateReadme(readmeContent);
              updateData.readme_content_zh = translatedReadme;
              processingStatus.readme_translated = true;
              logger.debug("README翻译完成", {
                originalLength: readmeContent.length,
                translatedLength: translatedReadme.length
              });
            } catch (error) {
              logger.error("README翻译失败:", error);
            }
          }

          // 处理Open Graph图片上传
          if (githubData.openGraphImageUrl && !repo.open_graph_image_oss_url) {
            logger.debug("STEP 7: 下载并上传Open Graph图片");
            try {
              const ossPath = aliyunOSSClient.generateOSSPath('og-image', repo.full_name, 'og-image.png');
              const uploadedOgImageUrl = await aliyunOSSClient.uploadFromUrl(githubData.openGraphImageUrl, ossPath);
              updateData.open_graph_image_oss_url = uploadedOgImageUrl;
              processingStatus.og_image_processed = true;
              logger.debug("Open Graph图片上传成功", { ogImageUrl: uploadedOgImageUrl });
            } catch (error) {
              logger.error("Open Graph图片上传失败:", error);
            }
          } else if (repo.open_graph_image_oss_url) {
            processingStatus.og_image_processed = true;
          }

          // 翻译Release Note
          if (githubData.latestRelease_description) {
            logger.debug("STEP 8: 翻译Release Note");
            try {
              const translatedReleaseNote = await translator.translateReleaseNote(githubData.latestRelease_description);
              updateData.latest_release_description_zh = translatedReleaseNote;
              processingStatus.release_note_translated = true;
              logger.debug("Release Note翻译完成", {
                original: githubData.latestRelease_description.substring(0, 50) + "...",
                translated: translatedReleaseNote.substring(0, 50) + "..."
              });
            } catch (error) {
              logger.error("Release Note翻译失败:", error);
            }
          }

          logger.debug("STEP 9: 保存快照记录");
          const snapshotAdded = await snapshotsService.addSnapshot(
            repo.id,
            stars,
            {
              mentionableUsers: githubData.mentionableUsers_count,
              watchers: githubData.watchers_count,
              pullRequests: githubData.pullRequests_count,
              releases: githubData.releases_count,
              forks: githubData.forks,
            }
          );
          logger.debug("快照添加状态", snapshotAdded);

          // 准备更新数据
          const data = {
            ...githubData,
            stars,
            contributor_count,
            // Map new fields from GitHub GraphQL API
            mentionable_users_count: githubData.mentionableUsers_count,
            watchers_count: githubData.watchers_count,
            license_spdx_id: githubData.license_spdxId,
            pull_requests_count: githubData.pullRequests_count,
            releases_count: githubData.releases_count,
            languages: githubData.languages_nodes,
            open_graph_image_url: githubData.openGraphImageUrl,
            uses_custom_open_graph_image: githubData.usesCustomOpenGraphImage,
            latest_release_name: githubData.latestRelease_name,
            latest_release_tag_name: githubData.latestRelease_tagName,
            latest_release_published_at: githubData.latestRelease_publishedAt ? new Date(githubData.latestRelease_publishedAt) : null,
            latest_release_url: githubData.latestRelease_url,
            latest_release_description: githubData.latestRelease_description,
            forks: githubData.forks,
            // 新增字段：README内容
            readme_content: readmeContent,
            // 合并处理后的数据
            ...updateData,
            readme_content_zh: updateData.readme_content_zh,
            updatedAt: new Date(),
          };

          logger.debug("STEP 10: 更新数据库记录", data);
          const result = await db
            .update(schema.repos)
            .set(data)
            .where(eq(schema.repos.id, repo.id));
          logger.debug("数据库更新完成", result.rowCount, repo.id);

          // 获取更新后的完整仓库数据
          const updatedRepo = await db
            .select()
            .from(schema.repos)
            .where(eq(schema.repos.id, repo.id))
            .limit(1);

          const finalRepo = updatedRepo[0] || { ...repo, ...data };

          // 发送webhook回调
          logger.warn("STEP 11: 发送webhook回调: ", finalRepo);
          const webhookUrls = process.env.DAILY_WEBHOOK_URL;
          if (webhookUrls) {
            try {
              const processingTime = Date.now() - startTime;
              const webhookRequest = createRepoWebhookRequest(
                {
                  ...finalRepo,
                  full_name: `${finalRepo.owner}/${finalRepo.name}`,
                },
                processingStatus,
                {
                  task_name: "update-github-data",
                  processed_at: new Date().toISOString(),
                  processing_time_ms: processingTime,
                  success: true,
                }
              );

              const results = await sendWebhookToMultipleUrls(
                webhookUrls,
                webhookRequest,
                {
                  token: process.env.DAILY_WEBHOOK_TOKEN,
                  timestamp: new Date().toISOString(),
                }
              );

              const successfulCount = results.filter(r => r.success).length;
              const totalCount = results.length;
              
              if (successfulCount > 0) {
                logger.debug(`Webhook回调成功发送到 ${successfulCount}/${totalCount} 个端点`);
              } else {
                logger.error("Webhook回调失败", results.map(r => ({ url: r.url, error: r.error })));
              }
            } catch (error) {
              logger.error("Webhook回调异常:", error);
            }
          }

          return {
            meta: { 
              updated: true, 
              snapshotAdded,
              iconProcessed: processingStatus.icon_processed ? 1 : 0,
              descriptionTranslated: processingStatus.description_translated ? 1 : 0,
              readmeTranslated: processingStatus.readme_translated ? 1 : 0,
              ogImageProcessed: processingStatus.og_image_processed ? 1 : 0,
              releaseNoteTranslated: processingStatus.release_note_translated ? 1 : 0,
              processingTime: Date.now() - startTime,
            },
            data: { 
              stars: finalRepo.stars,
              full_name: `${finalRepo.owner}/${finalRepo.name}`,
            },
          };

        } catch (error) {
          const processingTime = Date.now() - startTime;
          logger.error(`处理仓库失败: ${repo.full_name}`, error);

          // 发送错误webhook回调
          const webhookUrls = process.env.DAILY_WEBHOOK_URL;
          if (webhookUrls) {
            try {
              const webhookRequest = createRepoWebhookRequest(
                repo,
                processingStatus,
                {
                  task_name: "update-github-data",
                  processed_at: new Date().toISOString(),
                  processing_time_ms: processingTime,
                  success: false,
                  error_message: error instanceof Error ? error.message : String(error),
                }
              );

              const results = await sendWebhookToMultipleUrls(
                webhookUrls,
                webhookRequest,
                {
                  token: process.env.DAILY_WEBHOOK_TOKEN,
                  timestamp: new Date().toISOString(),
                }
              );

              const successfulCount = results.filter(r => r.success).length;
              const totalCount = results.length;
              
              if (successfulCount > 0) {
                logger.debug(`错误webhook回调成功发送到 ${successfulCount}/${totalCount} 个端点`);
              } else {
                logger.error("错误webhook回调失败", results.map(r => ({ url: r.url, error: r.error })));
              }
            } catch (webhookError) {
              logger.error("错误webhook回调失败:", webhookError);
            }
          }

          return {
            meta: { 
              updated: false, 
              error: true,
              processingTime,
            },
            data: { 
              stars: repo.stars,
              full_name: `${repo.owner}/${repo.name}`,
            },
          };
        }
      },
      { where: not(eq(schema.projects.status, "deprecated")) }
    );
  },
});
