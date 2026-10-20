# Vibe 工坊 connector：用你自己的 Codex 創作

「創作世界」（遊戲網址後面加 `/?create`）裡說一句「做一個點顏色得分的遊戲」，作品**不是遊戲伺服器做的**，
是你自己電腦上的這支 connector 叫**你自己的 Codex** 寫好，再送回遊戲裡。伺服器只負責檢查、保存、讓大家一起玩。

## 需要什麼

- **一台電腦**（macOS 或 Linux；Windows 沒測過，可以在 WSL 裡跑），裝好 **Node.js 20 以上**（`node --version` 看得到 v20 以上）。不用 `npm install`，connector 只用 Node 內建的功能。
- **你自己的 Codex CLI**，而且已經登入：
  ```sh
  codex --version     # 看得到版本號（例如 codex-cli 0.159.2）
  codex login         # 用你自己的 ChatGPT 帳號或 API key 登入（登入過就不用再做）
  ```
- 這台電腦跟遊戲伺服器在**同一個網路**（例如同一個 Wi‑Fi），而且打得開遊戲網址（例如 `http://192.168.1.20:5310`）。
- 這個 `connector/` 資料夾整個帶著（裡面的 `template/` 是給 Codex 的規格書和範例，少了不能跑）。

## 第一次：配對

1. 在遊戲的創作世界裡按「連接我的 Codex」，畫面會給你一組**配對碼**（10 分鐘內有效）。
2. 在電腦上（`connector/` 的上一層）執行：
   ```sh
   node connector/vibe-connector.mjs pair http://192.168.1.20:5310 配對碼
   ```
   看到「已連接：創作者 …」就成功了。可以加 `--label 書房的筆電` 幫這台電腦取個名字（不加就叫「我的 Codex」；connector 不會自己送出電腦名稱）。
3. 配對資料存在 `~/.vibe-connector/<伺服器>_<埠>.json`，只有你自己讀得到。裡面的 token 等於「可以替你交作品」的鑰匙，不要給別人；換電腦或弄丟了就重新配對一次。

## 每次要創作時：執行

```sh
node connector/vibe-connector.mjs run
```

（配對過好幾台伺服器時要指定：`run http://192.168.1.20:5310`。）讓它開著，回到遊戲裡說或打字就好：

- connector 收到工作 → 在暫存資料夾準備規格書與範例 → 執行 `codex exec` 讓 Codex 寫 `manifest.json`、`main.js`，並用 `node check.mjs` 自己檢查。
- 做好就送回伺服器；伺服器在沙盒裡試跑，沒過會把原因交回來，connector 會再請 Codex 修（最多 3 輪，`--max-attempts` 可以改）。
- 遊戲裡看得到進度（「Codex 正在跑 check.mjs…」「📝 寫入 main.js」之類），電腦這邊也會印出同樣的訊息和工作資料夾的位置。
- 結束：按 **Ctrl+C**。正在做的工作會停掉，遊戲裡會顯示「connector 被停止了」。

其他選項：`--codex /路徑/codex`（codex 不在 PATH 裡時）、`--once`（做完一個工作就結束）、`--state 檔案`（配對資料放別的地方）。

## 用的是誰的額度？

**你自己的。** connector 用你這台電腦上的 Codex 登入去執行，花的是你自己的 Codex（ChatGPT 方案或 API）額度。
額度用完時，遊戲裡會顯示「你的 Codex 額度用完了」，跟一般的失敗分開；等額度恢復再試就好。
沒登入或登入過期時會顯示「還沒登入」，請在這台電腦執行 `codex login`。

## 伺服器拿到什麼、拿不到什麼

- **拿到**：作品包（`manifest.json` 和 `main.js` 兩個檔）、進度摘要（一句一句的狀態）、失敗原因、來源紀錄（Codex 版本、第幾版、花了幾秒）。
- **拿不到**：你的 Codex／OpenAI 登入（connector 根本不讀那些檔案，是 Codex CLI 自己處理登入）、你的電腦名稱、帳號名稱、email、資料夾路徑、環境變數。
- connector 送出前會再檢查一次：作品或進度裡如果出現看起來像本機資訊（家目錄路徑、使用者名稱、電腦名稱、email、金鑰）的東西，就擋下來不送。
- Codex 是在暫存的工作資料夾裡、用 `workspace-write` 沙盒執行：只能寫那個資料夾（和系統暫存區），它執行的指令預設不能連網。
- 生成的作品程式 connector 自己不會執行；伺服器在零權限沙盒裡試跑，瀏覽器在隔離的沙盒裡執行。

## 只有 iPhone 可以嗎？

**第一版不行。** iPhone 可以在遊戲裡說話、打字、看進度、玩做好的作品，但「生成」要靠一台電腦跑 connector 和 Codex（iPhone 上沒辦法跑 Codex CLI）。
常見用法：電腦放著跑 `run`，人拿 iPhone（或戴手機眼鏡）在遊戲裡創作。

## 出問題時

| 看到 | 怎麼辦 |
|---|---|
| 配對碼不對或已過期 | 在遊戲裡重新產生一組（10 分鐘有效），再 pair 一次 |
| 配對失效，請重新 pair | 伺服器那邊的配對被清掉了：重新拿配對碼、重新 pair |
| 連不到伺服器 | 確認網址與埠號、同一個網路；connector 會自己每隔 1、2、4…（最多 30）秒重試 |
| 找不到 Codex | 安裝 Codex CLI，或用 `--codex` 指定它的路徑 |
| 還沒登入或登入已過期 | 在這台電腦執行 `codex login` |
| 額度用完了 | 等你的 Codex 額度恢復 |
| 試了 3 輪還是沒通過 | 換個說法、把需求說得簡單一點再試；工作資料夾（電腦上有印出位置）裡有 Codex 的紀錄 `events.jsonl` |

## 給開發者

- 協定與作品包格式：`docs/creation-sdk.md`。
- 給 Codex 的規格書：`template/AGENTS.md`；範例：`template/examples/`；本機自查：`node template/check.mjs <作品資料夾> [--base 舊版資料夾]`。
- 不花額度的協定測試：`run <伺服器> --fixture connector/fixtures/good --once`（`bad-then-fixed/` 第一版會壞、第 2 輪送修好的 `attempt2/`；`v2-migrate/` 是 `good` 的第 2 版，測保留狀態換版）。
- 單元測試：`node tests/connector-unit.mjs`（假的 codex、127.0.0.1 上的假伺服器，不連外、不花額度）。
