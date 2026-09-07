-- 為 webhook 處理 claim 加入 lease token，避免 stale worker 覆寫新的重試結果
ALTER TABLE cyberbiz_webhook_events ADD COLUMN processing_token TEXT;
ALTER TABLE cyberbiz_product_webhooks ADD COLUMN processing_token TEXT;
