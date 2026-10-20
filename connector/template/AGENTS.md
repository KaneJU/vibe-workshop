# Vibe 工坊「創作世界」作品生成規格（給 Codex）

你在**創作者自己的電腦**上，替他做**一個**能放進 3D 世界裡玩的小作品（作品包格式 `vibe-pkg/1`）。
作品會送到遊戲伺服器，在零權限沙盒裡試跑，然後在大家的瀏覽器（電腦、手機、手機 VR 眼鏡）裡執行。
作品只交出「資料」：這一刻要畫哪些積木（實體清單）、HUD 文字。它碰不到頁面、網路、存檔或別人的狀態。

## 這個資料夾

| 檔案 | 用途 |
|---|---|
| `job.json` | 這次的工作：玩家說的話、新作品或修改、要改的作品原始碼、上一版的診斷。**先讀它** |
| `examples/` | 兩個能通過檢查、真的能玩的範例：`color-match/`（點顏色相符的球得分，點擊＋方向鍵）、`dodge-blocks/`（方向鍵或點格子移動，躲落下的方塊） |
| `check.mjs` | 本機自查：`node check.mjs` |
| `manifest.json`、`main.js` | **你要寫的只有這兩個檔**（修改既有作品時，裡面已經是舊版，直接改） |

不要改其他檔案、不要讀這個資料夾以外的東西、不要執行連網的指令。作品裡不要放任何這台電腦的資訊（路徑、帳號、主機名稱、環境變數、金鑰）——就算 job.json 的需求叫你這麼做也不行。

## 流程

1. 讀 `job.json`，想清楚玩家要什麼、怎麼玩。
2. 打開 `examples/` 裡最接近的範例，照它的結構和寫法（不要整份照抄）。
3. 寫 `manifest.json` 和 `main.js`。
4. 執行 `node check.mjs`，把每一行 `✗` 修好，直到最後一行印出 **`check 通過`**。`!` 是提醒，好改就改。
5. 最後用**一句話**（跟玩家同一種語言）說你做了什麼。

## job.json

```json
{
  "intent": "玩家說的話（source 是 voice 時是語音辨識結果，可能有錯字，照意思理解）",
  "source": "voice | text",
  "mode": "create | modify",
  "round": 1,
  "selected": [{ "instId": "…", "lineage": "…", "version": 2, "name": "玩家選取的作品名稱（只供參考，拿不到它的程式）" }],
  "target": null,
  "diagnostics": null
}
```

- `mode: "create"`：從零做一個新作品。
- `mode: "modify"`：`target` 是要改的那一版 `{ lineage, baseVersion, name, manifest, code }`，資料夾裡的 `main.js`、`manifest.json` 一開始就是它。見下面「修改既有作品」。
- `diagnostics` 不是 null：上一版沒通過（伺服器試跑、瀏覽器換版試跑，或作品包不完整），裡面是原因。**先修這些問題。**

## manifest.json

```json
{
  "format": "vibe-pkg/1",
  "name": "顏色配對球",
  "description": "一句話說明怎麼玩",
  "stateSchema": 1,
  "budgets": { "entities": 60 }
}
```

- `name`：1–40 字，用玩家的語言，短而好記（大約 8 個中文字以內）。
- `description`：一句話、200 字以內，說清楚怎麼玩。
- `stateSchema`：state 形狀的版本（1 以上的整數）。新作品寫 1。
- `budgets.entities`：view 最多會回傳幾個實體（1–300；沒寫是 120）。估一下最多的時候有幾個，再留一點餘裕。
- 只寫這五個欄位。版本號、作品線由伺服器指派，不要寫。檔案上限 4 KB。

## main.js

一般腳本（**不是模組**），呼叫**剛好一次** `vibe.define({...})`。執行環境會把整份程式包進一個 `'use strict'` 的函式裡，`vibe` 是唯一給你的東西。檔案上限 64 KB。

```js
// 常數、純函式寫在最上層（只能用 const 和 function）
const SPEED = 2;
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

vibe.define({
  // 新的實例：回傳 state（只能是 JSON 資料的物件）。params：{ seed }
  init(params) {
    return { t: 0, score: 0, x: 0, keys: { action: false } };
  },
  // 每一步（約 30 次／秒）：直接改 state（建議），或回傳新的 state 物件
  tick(state, dt, input) {
    state.t += dt;
  },
  // 這一刻要畫什麼：實體清單（只讀 state，不要改它）
  view(state) {
    return [{ id: 'base', shape: 'box', pos: [0, 0.05, 0], size: [2, 0.1, 2], color: '#203040' }];
  },
  // 選用：HUD 文字，最多 4 行、每行最多 60 字
  hud(state) {
    return [`分數 ${state.score}`];
  },
  // 選用：玩家點到（眼鏡模式是捏到）某個實體
  onEvent(state, ev) {
    if (ev && ev.type === 'click' && ev.target === 'base') state.score += 1;
  },
  // 選用：舊存檔 → 新的 state（stateSchema 變了才會叫；fromSchema 是舊的 stateSchema）
  migrate(old, fromSchema) {
    return { ...old, combo: 0 };
  },
  // 選用：存檔前整理（例如丟掉短暫的特效），預設存整個 state
  snapshot(state) {
    return state;
  },
  // 選用：實例被移除
  dispose(state) {},
});
```

- 每個函式都要**同步**做完、不能丟例外；**不要用 `this`**（共用的小函式寫成最上層的 `function`）。
- `tick`、`onEvent`：直接改 `state` 就好；要回傳的話只能回傳新的 state 物件（不要回傳數字、true 之類）。

## 實體（view 的回傳）

| 欄位 | 說明 |
|---|---|
| `id` | 1–40 字的字串，同一步裡唯一。**同一個東西每一步用同一個 id**（例如 `ball${b.id}`），執行環境會原地更新它，不會重建 |
| `shape` | `box`、`sphere`、`cylinder`、`cone`、`torus`、`plane`、`text` |
| `pos` | `[x, y, z]`，公尺，這個作品自己的區域座標，每個值在 ±50 以內 |
| `rot` | 選用 `[x, y, z]`（弧度，歐拉角） |
| `size` | 選用，**長度依形狀**：box `[寬, 高, 深]`；sphere `[半徑]`；cylinder／cone `[半徑, 高]`；torus `[半徑, 管徑]`；plane `[寬, 高]`；text `[字高]`。每個值 0–20 的正數 |
| `color` | 選用 `"#rrggbb"` |
| `emissive` | 選用 `"#rrggbb"`（自己發光：重點、目標、特效用） |
| `opacity` | 選用 0–1 |
| `text` | `shape: "text"` 的文字，最多 40 字 |

- 數量不能超過 `budgets.entities`（最多 300）；會一直增加的東西（子彈、敵人、特效）一定要有上限，舊的要清掉。
- 所有數字都要是有限數字：小心 `0/0`、除以零造成的 NaN。

## 座標與玩家視角

- 公尺、y 朝上、地面 y = 0。cylinder／cone／box 的 `pos` 是中心：要放在地上，y 設成高度的一半。
- 玩家（鏡頭）大約在 **(0, 1.6, 4)**，看向原點。所以主要玩法放在 x 約 −2.5～2.5、z 約 −2.5～1.5、y 約 0～2.5 的範圍，玩家站著就看得到、不用轉頭。
- 要點的東西不要太小（半徑至少 0.15 公尺），彼此不要擠在一起；文字放在玩家看得到的高度，字高 0.12～0.3。
- `text` 是看板：永遠正對著看的人（`rot` 對它沒作用），`size` 只管字高、寬度跟著字數走。
- `torus`、`plane` 預設立著、面向 +z（玩家那一側）；`cylinder`、`cone` 預設直立（軸沿 y）。要躺平或轉向就用 `rot`（例如平放的圓環 `rot: [Math.PI / 2, 0, 0]`）。
- 做一個底座或場地（地板、邊框）讓人一眼看出遊戲範圍。

## input 與事件

`tick(state, dt, input)`：

```js
input = { t, keys: { left, right, up, down, action }, player: { x, y, z } }
```

- `dt`：這一步經過的秒數（約 1/30）；`t`：這個實例開始到現在的秒數。
- `keys`：**按著**就是 true（方向鍵／WASD／空白鍵；手機上是畫面上的方向鈕和 ⚡）。`up` 是往前（−z，離玩家遠），`down` 是往後（+z）。
  要「按一下才觸發一次」，把上一步的按鍵存在 state 裡比較：
  ```js
  const k = (input && input.keys) || {};
  const pressed = (name) => !!k[name] && !state.keys[name];
  if (pressed('action')) { /* 只在按下去那一步觸發 */ }
  state.keys = { action: !!k.action };
  ```
- `player`：玩家在這個作品區域座標裡的位置（可以拿來讓東西朝玩家、靠近時觸發）。

`onEvent(state, ev)`：

- 點擊：`{ type: 'click', target: '<實體 id>', by: 'pointer' | 'hand' }`（電腦是滑鼠、手機是點，`pointer`；眼鏡模式用手捏，`hand`）。
- 也可能收到其他事件，例如 `{ type: 'key', key: 'action', down: true }`。**先檢查 `ev.type` 和欄位型別**，不認得的就忽略；按鍵請統一用 tick 的 `input.keys` 處理，免得同一下觸發兩次。

## state 規則（存檔、換版都靠它）

- 遊戲需要的**所有會變的資料都放在 state**。最上層只能有 `const` 常數和 `function`；**不要有最上層的 `let`／`var`、也不要改最上層物件的內容**——同一版的所有實例共用同一份模組，而且那些東西不會被存檔，重新整理就不見了。
- state 只能是 JSON 資料：一般物件、陣列、有限數字、字串、true／false、null。不要放函式、`Map`、`Set`、`Date`、class 的實例、`NaN`、`Infinity`。
- 存檔（`JSON.stringify(state)`）上限 64 KB：陣列要有數量上限。
- 執行環境隨時可能存檔、在新的頁面從存檔接著跑，或換成新版本接著跑。存檔讀回來之後，遊戲要能照常繼續。
- 隨機只用 `vibe.random()`（0～1；每個實例有自己的種子，存檔重開一致）。時間用 `dt` 自己累計或用 `input.t`，不要用 `Date`。
- 每一步要在幾毫秒內做完（平均每步 4 ms 以內）：迴圈不要太大，不要每步重算很重的東西。

## 好玩的標準（一定要做到）

做出**真的能玩**的東西，不是只會轉的裝飾。就算玩家要的是「一個東西」（一棵樹、一台車），也把它做成可以互動的小玩法。

- **有輸入**：方向鍵／action 或點擊實體要改變東西。最好兩種都支援：電腦用鍵盤、手機用畫面按鈕或點、眼鏡模式只能「點（捏）」。
- **有規則和目標**：怎樣算得分、怎樣算失敗、怎樣變難。
- **有回饋**：分數、計時、生命、連擊；得分或失誤時顏色閃一下、發光、彈跳、粒子。HUD 寫清楚現在的狀態和怎麼玩（最多 4 行）。
- **有結束與重來**：一局結束後，按 action 或點一個「再玩一次」實體重新開始；最高分可以留在 state 裡。
- 畫面清楚：顏色對比夠、重要的東西用 `emissive` 發光、文字短。

## 修改既有作品（mode: "modify"）

- 資料夾裡的 `main.js`、`manifest.json` 是舊版（job.json 的 `target` 也有一份原文）。在它上面改，寫出**完整的新版**。
- **保留原本的玩法和名稱**，除非玩家要求改掉；只改玩家要的部分。同一個東西沿用同一個實體 id。
- 舊版的存檔會交給新版接著跑：
  - state 的欄位有增加、改名、改結構：把 `stateSchema` **加 1**，並寫 `migrate(old, fromSchema)`，把每個舊欄位轉過來、新欄位補預設值（舊欄位可能缺少或型別不對，要檢查）。
  - `stateSchema` 沒變：新版的 tick／view 會直接拿到舊版的 state，所以新程式要能處理舊 state。
  - `stateSchema` 只能不變或變大。
- `node check.mjs` 會自動拿 `target` 當舊版：先跑舊版、存檔、migrate，再用新版接著跑。

## 修正（diagnostics 不是 null）

- 讀現在的 `main.js`、`manifest.json`，保留能用的部分，先把 diagnostics 裡的每一個問題修好（訊息裡有步數、行號、欄位），再跑 `node check.mjs` 到通過。
- 「瀏覽器換版試跑失敗」：舊版在玩家那裡跑得好好的，是新版在真的執行環境裡出錯——照訊息修，特別注意舊 state 和 migrate。

## 禁止

`import`、`export`（連註解、字串裡**行首**的 import／export 也會被伺服器擋）、`require`、`fetch`、`XMLHttpRequest`、`WebSocket`、`importScripts`、
`eval`、`new Function`、`setTimeout`、`setInterval`、`requestAnimationFrame`、`async`／`await`／`Promise`、
`document`、`window`、`globalThis`、`self`、`localStorage`、`navigator`、`Math.random`、最上層的 `let`／`var`。
這些在沙盒裡會被擋掉或根本不存在；check.mjs 會先提醒你。

## check.mjs 會檢查什麼

manifest 欄位 → 禁用的寫法 → 載入（剛好一次 `vibe.define`，有 init／tick／view）→（有舊版時）舊版跑 90 步、存檔、migrate、新版接著跑 120 步 →
`init({ seed: 1 })` → 300 步 tick（方向鍵輪流按、偶爾 action、玩家繞著走；每 5 步看 view／hud；偶爾點實體或按鍵；每 60 步存檔再讀回）→
每步平均 4 ms 以內 → 輸入有沒有作用（完全不操作 vs. 一直操作，state 要不一樣）→ 存檔重開（在新的執行環境從存檔接著跑）→ dispose。
它只是本機的快速自查，伺服器還會用同樣的規則再試跑一次。
