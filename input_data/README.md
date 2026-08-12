# 隐私删除窗口材料

privacy_request.db是冻结的工单快照，包含用户、请求、设备、订单、消息和审计事件六张业务表。retention_exceptions.json记录税务、风控和法务保留条款。window/deletion_window.json给出窗口编号、计划时间、审批角色和回滚联系人。starter目录中的SQL尚未完成。

把完成SQL保存为output/sql/rebuild_privacy_window.sql，在input_data目录运行npm run process。入口会复制冻结快照，使用SQLite建立保留规则、对象动作、保留登记和窗口汇总，再导出审批材料。处理过程只读本地输入，不连接隐私平台或生产数据库。
