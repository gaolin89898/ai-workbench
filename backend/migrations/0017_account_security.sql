-- 账号安全加固：
--   1. users.disabled：管理员禁用账号的持久化列（此前 toggleDisableUser 写入不存在的列，实际会报错）。
--   2. users.is_admin：管理员标识改为数据库列，取代"email == 'admin' 即管理员"的判断，
--      防止通过桌面登录自动注册抢占 admin 账号获得后台权限。
--   3. 保留账号 admin 由应用层禁止注册；这里把存量 admin 账号标记为管理员。

ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE users SET is_admin = TRUE WHERE email = 'admin';
