PRAGMA foreign_keys = ON;

DROP TABLE IF EXISTS retention_rule;
CREATE TABLE retention_rule AS
SELECT
  json_extract(value, '$.exception_id') AS exception_id,
  json_extract(value, '$.rule_kind') AS rule_kind,
  json_extract(value, '$.scope') AS scope,
  json_extract(value, '$.user_id') AS user_id,
  json_extract(value, '$.retain_reason') AS retain_reason,
  json_extract(value, '$.retain_until') AS retain_until,
  json_extract(value, '$.created_from') AS created_from,
  json_extract(value, '$.order_statuses') AS order_statuses,
  json_extract(value, '$.event_types') AS event_types
FROM json_each(readfile('retention_exceptions.json'), '$.exceptions');

DROP TABLE IF EXISTS object_action;
CREATE TABLE object_action AS
WITH active_delete AS (
  SELECT request_id, user_id
  FROM privacy_requests
  WHERE request_type = 'delete' AND status = 'open'
),
scoped AS (
  SELECT request_id, user_id, 'users' AS object_type, user_id AS object_id, created_at AS object_created_at, account_status AS object_state
  FROM active_delete JOIN users USING (user_id)
  UNION ALL
  SELECT request_id, user_id, 'devices', device_id, last_seen_at, platform
  FROM active_delete JOIN devices USING (user_id)
  UNION ALL
  SELECT request_id, user_id, 'orders', order_id, created_at, order_status
  FROM active_delete JOIN orders USING (user_id)
  UNION ALL
  SELECT request_id, user_id, 'messages', message_id, created_at, thread_id
  FROM active_delete JOIN messages USING (user_id)
  UNION ALL
  SELECT request_id, user_id, 'audit_events', event_id, created_at, event_type
  FROM active_delete JOIN audit_events USING (user_id)
),
marked AS (
  SELECT
    scoped.*,
    CASE
      WHEN legal.exception_id IS NOT NULL THEN 'retain_exception'
      WHEN scoped.object_type = 'orders'
        AND scoped.object_state IN (SELECT value FROM json_each((SELECT order_statuses FROM retention_rule WHERE rule_kind = 'order_tax')))
        AND scoped.object_created_at >= (SELECT created_from FROM retention_rule WHERE rule_kind = 'order_tax')
        THEN 'retain_exception'
      WHEN scoped.object_type = 'audit_events'
        AND scoped.object_state IN (SELECT value FROM json_each((SELECT event_types FROM retention_rule WHERE rule_kind = 'audit_security')))
        THEN 'retain_exception'
      WHEN scoped.object_type = 'users' THEN 'anonymize_profile'
      ELSE 'delete'
    END AS planned_action,
    CASE
      WHEN legal.exception_id IS NOT NULL THEN legal.exception_id
      WHEN scoped.object_type = 'orders'
        AND scoped.object_state IN (SELECT value FROM json_each((SELECT order_statuses FROM retention_rule WHERE rule_kind = 'order_tax')))
        AND scoped.object_created_at >= (SELECT created_from FROM retention_rule WHERE rule_kind = 'order_tax')
        THEN (SELECT exception_id FROM retention_rule WHERE rule_kind = 'order_tax')
      WHEN scoped.object_type = 'audit_events'
        AND scoped.object_state IN (SELECT value FROM json_each((SELECT event_types FROM retention_rule WHERE rule_kind = 'audit_security')))
        THEN (SELECT exception_id FROM retention_rule WHERE rule_kind = 'audit_security')
      ELSE ''
    END AS exception_id
  FROM scoped
  LEFT JOIN retention_rule AS legal
    ON legal.rule_kind = 'legal_hold' AND legal.user_id = scoped.user_id
)
SELECT
  request_id,
  user_id,
  object_type,
  object_id,
  object_created_at,
  object_state,
  planned_action,
  exception_id,
  CASE
    WHEN planned_action = 'delete' THEN 'delete object after request approval'
    WHEN planned_action = 'anonymize_profile' THEN 'replace profile identifiers after child records are handled'
    ELSE 'retain because ' || (SELECT retain_reason FROM retention_rule WHERE retention_rule.exception_id = marked.exception_id)
  END AS action_rationale
FROM marked;

DROP TABLE IF EXISTS retention_register;
CREATE TABLE retention_register AS
SELECT
  object_action.request_id,
  object_action.user_id,
  object_action.object_type,
  object_action.object_id,
  object_action.exception_id,
  retention_rule.retain_reason,
  retention_rule.retain_until
FROM object_action
JOIN retention_rule USING (exception_id)
WHERE object_action.planned_action = 'retain_exception';

DROP TABLE IF EXISTS window_summary;
CREATE TABLE window_summary AS
SELECT 'open_delete_requests' AS metric, count(*) AS value FROM privacy_requests WHERE request_type = 'delete' AND status = 'open'
UNION ALL SELECT 'object_actions', count(*) FROM object_action
UNION ALL SELECT 'delete_actions', count(*) FROM object_action WHERE planned_action = 'delete'
UNION ALL SELECT 'anonymize_actions', count(*) FROM object_action WHERE planned_action = 'anonymize_profile'
UNION ALL SELECT 'retained_objects', count(*) FROM object_action WHERE planned_action = 'retain_exception'
UNION ALL SELECT 'legal_hold_objects', count(*) FROM retention_register WHERE exception_id = 'EX-LEGAL-HOLD'
UNION ALL SELECT 'order_tax_objects', count(*) FROM retention_register WHERE exception_id = 'EX-ORDER-TAX'
UNION ALL SELECT 'audit_security_objects', count(*) FROM retention_register WHERE exception_id = 'EX-AUDIT-SEC'
UNION ALL SELECT 'affected_users', count(DISTINCT user_id) FROM object_action
UNION ALL SELECT 'retention_rules', count(*) FROM retention_rule;
