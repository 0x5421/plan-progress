# plan-progress（多樣式版）

在 Claude Code 輸入框上方顯示即時進度條：Claude 接到多步驟任務時，會把工作拆成幾個階段和步驟，邊做邊更新，你看得到它走到哪。

這個版本是 [zycck/claude-mods](https://github.com/zycck/claude-mods) 裡 `plan-progress` 外掛的 **fork**（衍生版本），在原作上加了 6 種可切換的外觀和一個樣式面板。

## 原作者

**Kirill Serditov**（[@zycck](https://github.com/zycck)），以 MIT 授權發布。

本專案從原作 commit [`ea2c96b`](https://github.com/zycck/claude-mods/commit/ea2c96b7372b01d2d3d061597f319d531942a27c) 複製而來。以下功能都是原作者做的，本版本沿用：

- 進度條的運作機制：Claude 建立一次完整計畫，之後只送很短的更新（例如「下一步」）
- 寫進系統提示的使用規則，以及「連續動手幾次還沒建進度條就提醒」的檢查
- Subagent（子代理）狀態條：每個子代理正在做什麼、跑多久、是否在等你核准
- 需要你決定、出錯、完成時的提示音
- 底部的 **Progress** 按鈕，以及 `/progress`、`/progress-demo`、`/progress-sounds`、`/progress-clear` 指令
- 原版的像素顆粒進度條畫法（本版本保留為 `original` 樣式）

## 這個版本改了什麼

由 [@0x5421](https://github.com/0x5421) 修改。

| 類別 | 內容 |
|---|---|
| 新增 5 種樣式 | 分段 `segments`、細線 `hairline`、串珠 `beads`、刻度字 `ledger`、路線圖 `transit`，畫法在 `hooks/styles.ts` |
| 樣式面板 | 點輸入框下方的齒輪 **⚙**（或輸入 `/progress-style`）打開，6 種樣式各有即時預覽，點「使用」立刻切換 |
| 底部只留齒輪 | 原版底部的 **Progress** 按鈕拿掉，只留一個 **⚙**；顯示／隱藏進度條改在面板最上面切換 |
| 隱藏會一直記住 | 原版隱藏後，有新進度條或開新 session 就會自動跳回顯示。現在隱藏後一直保持隱藏，直到你按「顯示」或用 `/progress-demo` |
| 提示音開關 | 面板裡可以開關提示音，預設開；關掉後 `/progress-sounds` 試聽仍會響 |
| Subagent 顯示 | 面板最上面切換「展開／摘要／隱藏」：每個 subagent 一條、合成一行只顯示各狀態數量、或完全不顯示 |
| 完成音等回覆寫完才響 | 原版 Claude 一把最後一步標完成就變 Done、響完成音，那時回覆還沒寫。現在進度條先停在最後一步，等這一輪回覆整則寫完才變 Done、響一次完成音；subagent 全部跑完的完成音也一樣等到回覆寫完 |
| 其他 session 的狀態 | 桌面版每個 session 會把自己的狀態寫進 `~/.claude/plan-progress/sessions/`。其他 session 跑完或在等你決定時，會在進度條下方各顯示一行，按「切換」就跳過去，按 ✕ 會先變淡再消失、之後不再顯示；還在跑的只合成一行「另有 N 個 session 在跑」。**⚙** 面板的「其他 session」可以開關，預設開 |
| 自動收掉完成的進度條 | 原版完成的進度條會一直留著（最多 3 條）。現在你送出下一則訊息時，完成的那幾條會漸淡後消失，進行中的不受影響 |
| 記住選擇 | 選好的樣式、subagent 顯示方式、進度條顯示／隱藏、提示音開關都會存起來，下次開 session 沿用 |
| 切換指令 | `/progress-style` 打開面板並列出樣式；`/progress-style <名稱>` 直接切換；`/progress-style next` 換下一個 |
| 深淺色 | 新樣式的顏色跟著深淺色主題切換 |
| 規則調整 | 階段名一律用英文，任務標題和步驟仍用使用者的語言 |
| 修正 | 原版 subagent 條在淺色主題下文字幾乎看不見 |
| 修正 | 判斷「Claude 在問你問題」時也認得中文全形問號「？」，不會再把中文提問的回覆擋回去 |
| 測試 | `tests/panel.test.ts`：畫出 ⚙ 按鈕、樣式面板和 6 種樣式的進度條，並按按鈕確認會切換 |

## 樣式一覽

| 名稱 | 說明 |
|---|---|
| `segments`（預設） | 一個階段一格，所有階段名都看得到，陶土橘 |
| `hairline` | 2px 細線＋會呼吸的線頭，平常黑白，右邊顯示經過時間 |
| `beads` | 一步一顆珠子，同階段用線串起來，藍色 |
| `ledger` | 等寬字＋小方格，正在做的那格像游標閃，只有要注意時才有顏色 |
| `transit` | 像捷運路線圖，站名在下方，紫色，比其他樣式高一點 |
| `original` | 原作者的像素顆粒進度條 |

## 安裝

在 Claude Code 外的終端機執行：

```bash
claude plugin marketplace add 0x5421/plan-progress
claude plugin install plan-progress@fork-zycck-mods
```

已經下載到本機的話，第一行改成 `claude plugin marketplace add /path/to/plan-progress`。

開一個新的 session 就會載入。

### 改完之後更新

先把 `plugins/plan-progress/.claude-plugin/plugin.json` 的 `version` 加一，再執行：

```bash
claude plugin update plan-progress@fork-zycck-mods
```

版本號沒變的話，更新指令會說已經是最新版而不更新。

## 使用

- 想換外觀：點輸入框下方的齒輪 **⚙**（桌面版在模型選單左邊），或輸入 `/progress-style`，在面板裡點「使用」
- 想看示範：`/progress-demo`
- 隱藏／顯示進度條：在 **⚙** 面板最上面點「顯示」或「隱藏」，或輸入 `/progress`
- 開關提示音：在 **⚙** 面板的「提示音」點「開」或「關」
- 清掉所有進度條：`/progress-clear`

進度條在桌面版 app 顯示圖形；在終端機只顯示文字進度條，樣式切換不影響終端機。

## 測試

```bash
claude plugin test plugins/plan-progress
```

## 授權

MIT。原作版權屬於 Kirill Serditov，見 [LICENSE](LICENSE)；依 MIT 授權，轉發或修改時必須保留這份版權聲明與授權文字。本版本的修改同樣以 MIT 授權提供。
