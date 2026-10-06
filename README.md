# LiveLingo — 即時字幕翻譯

> 聆聽現場或線上的聲音，即時產生逐字稿並翻譯，以雙語字幕呈現。
> A Chrome extension (MV3) that turns live speech into real-time bilingual subtitles.

為了一場**外籍學者來台演講**而做的工具。演講以英文進行、觀眾是中文聽眾，而 Q&A 時雙方要互相理解——
需要**同時**處理「英文→中文」和「中文→英文」兩個方向。

技術組成：**Deepgram**（即時語音辨識，WebSocket 串流）＋ **DeepL**（翻譯，REST）。
純 JavaScript，無建置流程、無後端。

---

## 三種使用模式

| 模式 | 音訊來源 | 畫面 | 適用情境 |
|---|---|---|---|
| **演講投影字幕** | 混音器 / 麥克風 | 全螢幕黑底投影頁 | 實體演講，字幕投到大螢幕 |
| **麥克風翻譯** | 麥克風 | 一般視窗、可捲動逐字稿 | 會議、面對面對談 |
| **分頁字幕** | 分頁音訊（`chrome.tabCapture`） | 網頁上可拖曳的浮動字幕 | YouTube、Twitch 等線上影音 |

三者共用同一套音訊處理（`pcm-worklet.js`）與同一個 DeepL 用戶端（`deepl.js`）。

### 演講投影模式

- **單向模式**：單欄置中、限制行寬，純粹呈現翻譯
- **雙向模式（QA）**：左右分割，左欄「English → 中文」、右欄「中文 → English」
- 兩欄各有**獨立的暫停鍵**（快捷鍵 `L` / `R`），演講中可先關掉不需要的方向
- 每欄固定識別色，開場說一句「中文看藍色那邊」觀眾就能鎖定
- 可調：字幕位置、字型（黑體／明體）、字級（5 段，最大 90px）、是否顯示原文
- 全螢幕、可隱藏設定列（`H`），投影畫面保持乾淨

---

## 開發中解決的問題

這個專案的難點幾乎都不在「串 API」，而在串起來之後才會遇到的細節。

### 1. 斷句：`is_final` 不等於「這句話說完了」

Deepgram 的 `is_final` 只代表「**這一小段文字不會再變動**」，不代表句子結束。
直接用它來送翻譯，會得到這種結果：

```
"The humans"  /  "have input."  /  "that"
```

每個碎片被**獨立送去翻譯**，語意全毀（`that` → 「那個」）。

改為：累積片段，**優先用標點符號斷句**，句尾未完成的部分留到下一段接續。
`speech_final` 刻意不觸發送出——它在講者換氣時也會觸發，正是斷句錯亂的來源。

```
修正前：So those | two are memorable.
修正後：So those two are memorable.
```

另有安全閥（字數、秒數上限），避免講者完全不停頓時字幕卡住。

### 2. 中文與英文的資訊密度不同

字數上限原本兩個方向共用，結果「中翻英」那側產出的文字量是另一側的兩倍以上——
**100 個中文字翻成英文可能變成 150～200 個英文字**。

改為依**來源語言**分別設定上限（中文來源的上限約為英文的一半），並讓英文字級等比縮小，
左右兩欄的視覺重量才會平衡。

### 3. Deepgram 即時串流不支援中文 code-switching

`language=multi` 只涵蓋 en/es/fr/de/hi/ru/pt/ja/it/nl，**中文不在內**；
即時串流也**不支援自動語言偵測**（`detect_language` 只對預錄音檔有效）。

所以雙向模式是**同時開兩條 WebSocket**，各自鎖定一種語言，共用同一份音訊。
代價是「閒置的那一側會持續誤聽另一種語言」，再用信心分數過濾掉。

### 4. 暫停時不能斷線

操作人員需要在演講中暫時關掉某個方向。直接斷開 WebSocket 的話，恢復要等約 1 秒重連，會漏掉開頭幾個字。

改為：**停止送音訊**（Deepgram 按音訊時長計費，不送就不計費），
但每 5 秒送一個 `KeepAlive` 維持連線——恢復是瞬間的，暫停期間也不花錢。

### 5. MV3 的 service worker 會被回收

Service worker 閒置約 30 秒就會被 Chrome 終止，**記憶體變數全部歸零**；
但 offscreen document 會繼續活著、繼續佔用分頁錄音。

結果是：popup 以為沒在錄音，實際上還在，再按一次就得到
`Cannot capture a tab with an active stream`，而且永遠解不開。

修法：工作階段狀態改存 `chrome.storage.session`，並在每次開始前**強制釋放**既有的擷取。

### 6. Content script 的生命週期

manifest 宣告的 content script **只在網頁載入時注入**，所以擴充功能重新載入後，
既有分頁裡是舊的（或根本沒有）腳本。而舊腳本的 `chrome.*` 呼叫會丟出
`Extension context invalidated`。

修法：改為按需注入，並把 content script 寫成**可重入**——
新實例會先清除舊實例（移除 DOM 與所有監聽器），所有 `chrome.*` 呼叫都包上防護。

### 7. 放大字體會讓自動捲動失效

原本每次新增字幕時重新判斷「是否接近底部」。字級一放大，內容高度暴增、
距離底部瞬間變遠，被誤判成「使用者自己捲上去了」，就不再跟隨最新字幕。

修法：改成記住「**是否鎖定在底部**」的狀態，只有使用者**真的捲動**時才改變；
字級、版面、視窗大小變化時則重新對齊。

### 8. DeepL Free 方案只允許 1 份詞彙表

詞彙表原本依方向建立兩份（英→中、中→英），在 Free 方案上**第一次就必定失敗**——
建完第一份就已達上限。

改用 **v3 多語詞彙表**：一份詞彙表內含多個方向的字典，**只算 1 份**。

---

## 翻譯品質的調校

- **`context`**：把前兩句原文一併送給 DeepL 作為上下文。它不會被翻譯、**也不計費**，
  但能讓代名詞與承接語氣翻得更準——逐句翻譯最容易丟失的就是這個。
- **詞彙表**：固定專有名詞的譯法（例如 `udn` → `聯合報`），避免被音譯。
  設定頁可直接編輯、查看與刪除。

---

## 安裝

無建置流程，純 JS/HTML/CSS。

1. `chrome://extensions` → 開啟「開發人員模式」
2. 「載入未封裝項目」→ 選擇本資料夾
3. 進「選項」頁，填入 **Deepgram** 與 **DeepL** 的 API Key
   （兩者皆為第三方服務，需自行申請；金鑰存於 `chrome.storage.sync`，不會寫入任何檔案）

```bash
# 專案沒有測試框架，至少做語法與設定檔驗證
for f in *.js; do node --check "$f"; done
python3 -c "import json; json.load(open('manifest.json'))"
```

## 檔案結構

```
manifest.json     MV3 設定
background.js     Service worker：分頁擷取、offscreen 生命週期、訊息轉送
offscreen.js      分頁音訊擷取（MV3 的 service worker 無法持有 MediaStream）
pcm-worklet.js    AudioWorklet：任意取樣率 → 16kHz 單聲道 PCM16
deepl.js          共用的 DeepL 用戶端：翻譯、context、詞彙表管理
live.html/js      演講投影頁
mic.html/js       麥克風翻譯頁
content.js/css    注入網頁的浮動字幕（可拖曳、可調寬、可重入）
popup.html/js     外掛選單
options.html/js   API Key 與詞彙表設定
```

## 已知限制

- **DRM 網站無法擷取**：Netflix、Disney+ 等會阻擋 `tabCapture`；YouTube、Twitch 正常
- **必須指定原始語言**：Deepgram 即時串流不支援自動語言偵測
- **有延遲**：語音 → 辨識 → 翻譯約數秒，非零時差
- **依賴付費 API**：Deepgram 與 DeepL 皆需自備金鑰，依用量計費
- **尚無自動化測試**：系統高度依賴即時音訊與第三方 API，目前以實機驗證為主

## 授權

尚未指定。這是任職單位相關的專案，授權方式待確認後再補上 `LICENSE`。
