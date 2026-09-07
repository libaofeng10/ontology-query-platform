# 数据源关系评测

评测入口：`node scripts/eval-source-relations.mjs --help`。

工具复用应用的探查、提案、采样、模型审阅、补采样与基数归一化流程。实测时读取项目 SQLite 中指定数据源及当前模型/画像设置，在临时目录保存本次目录和知识页，结束即清理；业务库仅执行只读查询，项目目录和已发布本体不被改写。

## 离线指标自检

```sh
node scripts/eval-source-relations.mjs \
  --truth server/test/fixtures/relation-evaluation-truth.json \
  --predictions server/test/fixtures/relation-evaluation-predictions.json \
  --out /tmp/relation-evaluation-synthetic.json
```

该样例人为包含一个正确预测和一个错误预测，默认 0.55 阈值下 precision=0.5、recall=1；0.85 时 precision=1。它验证指标计算，不能用来说明真实模型准确率。样例没有实测时延或 token，相关指标为 null。

## 准备业务真值

复制 truth 样例并填写当前数据源的真实表名和完整等式组。单列关系也使用一个成员的 `columnPairs`。`label=relation` 表示业务已确认的关系，`label=none` 是明确的反例；不要把未确认关系标为反例。基数使用 `1:1 / 1:N / N:1 / N:N`，方向以 fromTable 指向 toTable 为准。

`complete=true` 表示标注者确认所选表中的真实关系已经完整列出，此时未列出的预测可计为假阳性。只有部分标注时必须用 `complete=false`：工具单列未标注预测，只报告已标注精度/召回，不宣称完整召回。反向、重复、部分联合等式不会重复算作命中。

候选召回衡量真值能否进入规则/提案及外键集合；精度和召回衡量达到评测阈值的正向模型判断，均不等同于自动确认或发布。有数据库外键时，另报 `logicalRelationsOnly`，剔除外键的直接命中，单独评估逻辑关系发现。方向准确率单独衡量是否与标注方向一致；基数准确率会先将反向预测换算到标注方向。真值不是检索知识，不发送给模型。

## 真实数据库与模型

在已授权的测试数据源上执行；使用该项目的环境变量和 SQLite 配置：

```sh
node scripts/eval-source-relations.mjs \
  --truth /absolute/path/business-relation-truth.json \
  --source-id 2 --execute \
  --out /tmp/business-relation-report.json
```

`--source-id 2` 仅为参数示例，须替换为实际测试源 ID。评测拒绝真值中当前已被排除的表。成功后报告旁另存 `.predictions.json`，可用于离线重算阈值；不包含源采样值、连接密码或 API Key。退出码 2 表示模型判断或提案未完整完成，须结合 diagnostics 判断预算、配置或模型失败。

报告包括候选召回、精度/召回、方向/基数准确率、遗漏关系、查询数、总耗时、提案覆盖、补采样数及模型 token。费用只有模型报告了全部调用的用量，且显式提供 `--input-usd-per-million` 与 `--output-usd-per-million` 时才计算；未知费用不显示为零。阈值扫描只重算同一批判断，不能代替独立验证集上的阈值标定。

真实评测需另行记录 MySQL 版本、样本时间、所用真值版本及模型版本。建议保存多次运行报告比较波动；这些数据没有齐备前，不得把合成回归通过率写成真实精确率或召回率。数据源重建及部署仍是单独的环境操作。
