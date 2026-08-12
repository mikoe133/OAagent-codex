DELETE FROM automation_job_tags
WHERE job_id IN (
    SELECT id FROM automation_jobs WHERE job_key = 'github-project-progress-sync'
)
AND tag_id IN (
    SELECT id FROM automation_tags WHERE normalized_name IN ('github', '项目进度', 'ai 总结')
);

DELETE FROM automation_prompt_profiles
WHERE job_type = 'github_project_progress_sync';

DELETE FROM automation_jobs
WHERE job_key = 'github-project-progress-sync';

DELETE FROM automation_tags
WHERE normalized_name IN ('github', '项目进度', 'ai 总结');
