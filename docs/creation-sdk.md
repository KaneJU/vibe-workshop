# 創作世界：作品包 SDK 與協定（vibe-pkg/1）

「創作世界」（`/?create`）把**生成**和**運行**分開：創作者用**自己的 Codex**（在自己電腦上跑 `connector/vibe-connector.mjs`）寫出作品包，
遊戲伺服器只收程式包、在零權限沙盒裡驗證與影子試跑、保存不可變版本；瀏覽器在 sandbox iframe 裡的 Worker 執行作品，
作品只能交出「資料」（要畫什麼、HUD 文字），碰不到頁面、網路、存檔或別人的狀態。

## 1. 作品包

一個版本＝兩個檔案，內容雜湊固定、版本號由伺服器指派（同一條作品線 lineage 單調遞增），舊版永遠保留。

`manifest.json`

```json
{
  "format": "vibe-pkg/1",
  "name": "顏色配對球",
  "description": "一句話說明玩法",
  "stateSchema": 1,
  "budgets": { "entities": 120 }
}
```

`main.js`：一般腳本（**不能有 import／export**），呼叫一次 `vibe.define({...})`：

```js
vibe.define({
  // 新的實例：回傳這個實例的狀態（必須是 JSON 可以表示的資料）。params：{ seed }
  init(params) {
    return { score: 0, t: 0, balls: [] };
  },
  // 每一步（約 30 次／秒）：可以直接改 state，或回傳新的 state
  tick(state, dt, input) {
    state.t += dt;
  },
  // 要畫什麼（只是資料）：實體清單，座標是這個實例自己的區域座標（公尺，y 朝上，地面 y=0）
  view(state) {
    return [{ id: 'base', shape: 'box', pos: [0, 0.05, 0], size: [2, 0.1, 2], color: '#203040' }];
  },
  // 選用：HUD 文字（最多 4 行，每行最多 60 字）
  hud(state) {
    return [`分數 ${state.score}`];
  },
  // 選用：玩家點到（或在眼鏡模式捏到）某個實體、按鍵
  onEvent(state, ev) {
    if (ev.type === 'click' && ev.target.startsWith('ball')) state.score += 1;
  },
  // 選用：舊版狀態 → 新版（stateSchema 變了才會叫；stateSchema 變了就一定要寫，影子試跑會用上一版真的跑出來的存檔測它）
  migrate(old, fromSchema) {
    return { ...old, combo: 0 };
  },
  // 選用：存檔前整理（預設整個 state）
  snapshot(state) {
    return state;
  },
  // 選用：實例被移除
  dispose(state) {},
});
```

### 實體（view 的回傳）

| 欄位 | 說明 |
|---|---|
| `id` | 字串，同一個實例內唯一；同一個 id 每一步會更新同一個物件（不會重建） |
| `shape` | `box`、`sphere`、`cylinder`、`cone`、`torus`、`plane`、`text` |
| `pos` | `[x, y, z]`（公尺，區域座標；範圍 ±50） |
| `rot` | 選用 `[x, y, z]`（弧度，歐拉角） |
| `size` | 選用：box `[寬, 高, 深]`；sphere `[半徑]`；cylinder／cone `[半徑, 高]`；torus `[半徑, 管徑]`；plane `[寬, 高]`；text `[字高]` |
| `color` | 選用 `#rrggbb` |
| `emissive` | 選用 `#rrggbb`（自己發光） |
| `opacity` | 選用 0–1 |
| `text` | `shape: 'text'` 的文字（最多 40 字）；文字是永遠面向玩家的看板，`rot` 對它沒有作用 |

上限：每個實例 `budgets.entities`（最多 300）個實體；超過的會被截掉並記錄錯誤。

### 事件（onEvent 的第二個參數）

- `{ type: 'click', target: 實體 id, by: 'pointer' 或 'hand' }`：滑鼠／手指點到，或眼鏡模式裡捏到
- `{ type: 'key', key: 'action', down: true }`：動作鍵（影子試跑會送這種）

### input（tick 的第三個參數）

```js
{ t, keys: { left, right, up, down, action }, player: { x, y, z } }
```

`t`：這個實例開始到現在的秒數；`keys`：方向鍵／WASD／空白鍵（手機上是畫面上的方向鈕；眼鏡模式是視線下方的方向鍵，用手捏住＝按住、張開＝放開，`action` 是 ⚡）；`player`：玩家（鏡頭）在這個實例區域座標的位置。
按鍵一定會放開：換層、交出執行權、離開眼鏡模式、切到背景、視窗失焦、眼鏡裡手不見時，全部的鍵都變回 `false`。

### 規則

- 只能用標準 JavaScript（Math、陣列、物件…）。**不能**用 `fetch`、`XMLHttpRequest`、`WebSocket`、`importScripts`、`eval`、`new Function`、計時器、DOM——在沙盒裡會被擋掉或根本不存在。
- 隨機請用 `vibe.random()`（每個實例有自己的種子，存檔重開一致）。
- state 要能 `JSON.stringify`，存檔上限 64 KB。
- 每一步的計算要在幾毫秒內完成；太慢或無限迴圈的作品會被停掉、退回上一個可玩的版本。

## 2. 執行與換版

- **伺服器影子試跑**（`server/shadow-harness.js`）：Deno、不給任何權限（讀寫檔、網路、環境變數、子程序都被擋），`--no-remote --no-npm`，`ulimit -t` CPU 秒數、記憶體上限、牆鐘逾時就整個程序殺掉。試跑：init → 300 步 tick（隨機按鍵、玩家移動）→ view／hud／onEvent → JSON 存檔大小 → 有上一版時用上一版的存檔跑 migrate 再繼續。失敗的診斷回給同一位創作者的 connector 修正。
- **瀏覽器執行**（`public/sandbox/runner.html`＋`public/sandbox-host.mjs`）：`<iframe sandbox="allow-scripts">`（不同源、讀不到頁面、cookie、localStorage），回應標頭 CSP `connect-src 'none'`（不能連網）、沒有 `unsafe-eval`；每個作品版本一個 classic Worker。頁面只收資料（實體清單、HUD），逐項檢查格式與數量；Worker 沒回應就整個停掉。
- **換版（不重新整理、不清空世界）**：新版先在影子實例上用「舊版目前的存檔」跑 migrate 和 30 步試跑 → 通過才在同一格切換（同樣的實體 id 原地更新）→ 觀察 3 秒，新版出錯就退回舊版和切換當下的狀態 → 觀察期過了才停掉舊版 Worker（資源釋放）。新版只要試跑沒過，舊版照常在玩。

## 3. 世界與嵌套

- 世界是一個容器：放在裡面的作品實例（各自的狀態）＋通往子世界的傳送門。根世界是 `root`。
- 在任何一層都可以說需求／打字建立新作品、修改選取的作品、開一個子世界（傳送門）。「新作品」「改選取的」是明確的模式：選取不會自己變成修改，要按「✏️ 改」；改選別的作品就回到新作品。開口（或按送出）那一刻就記下「哪一層、新作品還是改哪一件的哪一版」，之後換層、換選取都不影響那一句。
- 退回上一版：把這一層同一條作品線、同一版的實例一起換回上一個能用的版本（同一筆換版交易、同樣的影子試跑與觀察期）；上一版的 `stateSchema` 一樣才帶著現在的狀態退，不一樣就不退。退回之後再說要怎麼改，就以退回的那一版為基準。
- **按需載入**：只有目前所在的那一層在執行；其他層只是存檔裡的引用（世界 id、作品線＋版本、狀態）。進入子世界時，目前這層先存檔再停掉；返回時子世界存檔停掉、上一層從存檔恢復。載入途中麵包屑先換成新的一層並標「⏳ 載入中…」、「回上一層」先停用，作品全部起來才解除（診斷用的 `state().loading` 同步變成 false；`world` 會比作品先換，等「到了」要等 `loading` 結束）。接手（重建成最新存檔）與只看的分頁跟著存檔重建這一層時，`state().loading` 也是 true（`loadingWhy`：`takeover`／`resync`）；接手完成前點擊、捏合不算，按住的方向鍵等接手完才開始動。
- 作品庫是共用的：在 C 層做的作品，回到 A 層一樣能放；同一個作品放兩個，各有各的狀態。每個實例都有自己的 id，點擊與修改都指向那一個實例。
- 沒有固定的層數上限；有資源上限：每個世界最多 200 個實例、每位創作者最多 2000 個世界、每個存檔 64 KB。世界是樹狀（只能在目前這層開子世界），不會形成循環。

## 3.1 同一層在好幾個分頁／瀏覽器開著

- **只有一個執行者**：拿到這一層「執行權」（lease）的分頁在跑作品、存檔；其他分頁「只看」——不跑作品、不存檔，伺服器每次有人存檔就通知它們（SSE），它們照存檔重建畫面（新作品、分數、換版都跟上），不用重新整理。
- **接手**：只看的分頁一點作品、按方向鍵（鍵盤或手機畫面上的方向鈕）、在眼鏡模式捏作品、要放作品或換版，就請伺服器交接（點擊／捏的那一下只拿來接手、不送給作品；方向鍵按住的話接手後就照著動，很快點一下只拿來接手）：伺服器通知目前的執行者先存檔再交出（最多等 3 秒，沒回應就直接交），接手的分頁從那份最新存檔接著跑——分數不會掉，也不會兩邊各算各的。
- **斷線**：執行者 15 秒沒續執行權就到期，別的分頁可以接手（從最後一次存檔接著；斷線那幾秒沒存到的不算）。斷線的分頁重新連上時，如果已經被接手，就改成只看、同步成最新存檔，**不會用自己的舊狀態覆蓋**；沒人接手就繼續當執行者。伺服器重開時大家會自動重連。
- **不需要執行權的變動**：開子世界（加傳送門）、把作品放到別的層，伺服器直接合併並通知；執行者把它們併進來，自己正在跑的狀態不變。存檔時 revision 對不上就先合併再存，不會覆蓋別人加的東西。
- 這是「同一台伺服器上的分頁／瀏覽器輪流執行」，不是真正多人同時在同一層各自操作；多人同時玩同一層（輸入轉送、同步模擬）待做。

## 4. 協定（伺服器 API）

身分是「這台瀏覽器的創作者」（cookie `vw_creator`），不是帳號，也不經手任何 OpenAI／Codex 憑證。

| 方法 | 路徑 | 誰 | 說明 |
|---|---|---|---|
| POST | `/api/me` | 瀏覽器 | 取得／建立這台瀏覽器的創作者 `{ creatorId, name, connector }` |
| POST | `/api/connector/code` | 瀏覽器 | 產生 10 分鐘有效的配對碼 |
| POST | `/api/connector/pair` | connector | `{ code, label }` → `{ token, creatorId }`（token 只回一次；伺服器只存雜湊） |
| GET | `/api/connector/jobs?wait=25` | connector（Bearer） | 長輪詢：只拿得到**自己這位創作者**的工作 |
| POST | `/api/connector/jobs/:id/progress` | connector | `{ message }` |
| POST | `/api/connector/jobs/:id/package` | connector | `{ manifest, files: { 'main.js' }, provenance }` → 驗證＋影子試跑 → `{ ok, lineage, version }` 或 `{ ok: false, diagnostics }` |
| POST | `/api/connector/jobs/:id/fail` | connector | `{ message, quota }`（例如 Codex 沒登入；`quota: true`＝額度用完，跟一般失敗分開） |
| POST | `/api/create` | 瀏覽器 | `{ utteranceId, intent, source（voice 或 text）, worldId, selected, targetLineage, baseVersion }` → 工作（同一個 utteranceId 只會建一次）。交作品包時，**送出這個需求之後**才出現、比 `baseVersion` 新而且能用的版本＝衝突（`conflict`，不覆蓋）；送出前就有的新版不算（例如先退回上一版再改）。影子試跑拿 `baseVersion` 那一版跑出來的存檔試遷移 |
| GET | `/api/create/:id` | 瀏覽器 | 工作狀態：`queued`、`working`、`built`、`needs-fix`、`failed`、`cancelled`、`conflict` |
| POST | `/api/create/:id/cancel` | 瀏覽器 | 取消 |
| POST | `/api/create/:id/runtime-fail` | 瀏覽器 | 新版在瀏覽器換版試跑失敗：診斷回到同一個工作，connector 會再修 |
| GET | `/api/lineages` | 瀏覽器 | 作品庫（作品線、版本、創作者） |
| GET | `/pkg/:lineage/:version/main.js`、`manifest.json` | 瀏覽器 | 不可變版本 |
| GET／POST／PUT | `/api/cworlds`… | 瀏覽器 | 世界：讀取、開子世界（直接合併）、存檔（帶 `baseRevision` 與 `client`；revision 不一致或不是執行者都回 409） |
| POST | `/api/cworlds/:id/lease` | 瀏覽器 | `{ client, action }`：`claim`（沒人跑才拿）、`take`（請執行者交出）、`renew`、`release` |
| POST | `/api/cworlds/:id/items` | 瀏覽器 | `{ item, client }`：把一個作品實例加進某一層（伺服器合併、通知） |
| GET | `/api/cworlds/:id/events?client=` | 瀏覽器 | SSE：`hello`、`revision`（誰存的、為什麼）、`lease`、`handover`、`presence` |

沒有連上 connector 的創作者送出需求時，工作會等在佇列裡並提示「先連接你自己的 Codex」；**不會改用伺服器主人的 Codex**。自由工坊原本的「打造」仍是伺服器主人自用的生成方式，跟創作世界分開。
