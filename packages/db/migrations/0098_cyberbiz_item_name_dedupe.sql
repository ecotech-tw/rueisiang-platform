/* 官網品項的名稱去掉重複的商品名。

   官網的 variant_name 本身就是「商品名 - 規格」，接在商品名後面等於把商品名寫兩次：
   單一款式變成「賦活草本液體皂（賦活草本液體皂 -）」，有規格的變成
   「洗護合一組（洗護合一組 - 黑豆液體皂 + 護髮素）」。

   只改跟當初機器產出一模一樣的名字。人改過的名字形狀不會吻合，於是原封不動——
   同步本來就以人取的名字優先，這裡不能反過來把它洗掉。

   trim(x, ' -') 會把頭尾的空白與連字號一起去掉：切完商品名前綴之後，單一款式的
   商品會剩下一個孤零零的連字號（官網那邊規格是空的）。 */
WITH `named` AS (
  SELECT
    `p`.`item_id` AS `item_id`,
    `p`.`product_name` AS `product_name`,
    `p`.`variant_name` AS `variant_name`,
    trim(
      CASE
        WHEN instr(`p`.`variant_name`, `p`.`product_name`) = 1
        THEN substr(`p`.`variant_name`, length(`p`.`product_name`) + 1)
        ELSE `p`.`variant_name`
      END,
      ' -'
    ) AS `spec`
  FROM `cyberbiz_products` `p`
)
UPDATE `items`
SET
  `name` = (
    SELECT
      CASE
        WHEN `n`.`spec` = '' THEN `n`.`product_name`
        ELSE `n`.`product_name` || '（' || `n`.`spec` || '）'
      END
    FROM `named` `n`
    WHERE `n`.`item_id` = `items`.`id`
  ),
  `updated_at` = CURRENT_TIMESTAMP
WHERE `id` IN (
  SELECT `n`.`item_id`
  FROM `named` `n`
  JOIN `items` `i` ON `i`.`id` = `n`.`item_id`
  WHERE `i`.`name` = CASE
      WHEN trim(`n`.`variant_name`) = '' THEN `n`.`product_name`
      ELSE `n`.`product_name` || '（' || `n`.`variant_name` || '）'
    END
    OR `i`.`name` = `n`.`product_name` || ' - ' || `n`.`variant_name`
);
