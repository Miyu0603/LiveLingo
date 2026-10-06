# LiveLingo — 即時字幕翻譯 Chrome 外掛

擷取瀏覽器分頁（YouTube、Twitch 等直播網站）輸出的聲音，即時產生逐字稿（Deepgram）並翻譯（DeepL），以可拖曳的浮動字幕顯示在網頁上。

## 架構

```
popup.js  ──(使用者點擊「開始」)──▶  background.js (service worker)
                                        │  chrome.tabCapture.getMediaStreamId()
                                        ▼
                              offscreen.html / offscreen.js
                                  │ getUserMedia(streamId) 擷取分頁音訊
                                  │ 同時接回 AudioContext.destination，維持喇叭正常出聲
                                  │ AudioWorklet (pcm-worklet.js) 降頻成 16kHz PCM16
                                  ▼
                         WebSocket → Deepgram（即時逐字稿）
                                  │ is_final 句子
                                  ▼
                              fetch → DeepL（翻譯）
                                  │
                                  ▼
                 background.js 轉發 → content.js 浮動字幕 div（可拖曳）
```

MV3 的 `tabCapture` 無法直接在 service worker 中處理 `MediaStream`，因此依官方建議的模式，
由 background 取得 `streamId` 後交給一個隱藏的 **offscreen document** 實際做音訊擷取與 WebSocket 串流。

## 檔案說明

| 檔案 | 用途 |
|---|---|
| `manifest.json` | MV3 設定，宣告 `tabCapture`、`offscreen`、`storage` 權限 |
| `background.js` | service worker：取得分頁音訊串流 id、管理 offscreen document、轉發字幕/翻譯結果 |
| `offscreen.html/js` | 實際的音訊擷取 + Deepgram WebSocket + DeepL 翻譯 |
| `pcm-worklet.js` | AudioWorklet：把分頁音訊降頻為 16kHz 單聲道 PCM16，符合 Deepgram 要求 |
| `content.js/css` | 注入頁面的浮動字幕 div，可拖曳、可調字體大小、可隱藏 |
| `popup.html/js` | 點擊外掛圖示後的介面：選語言、字幕句數、字體大小、開始/停止、開啟麥克風頁面 |
| `options.html/js` | 設定頁：輸入 Deepgram / DeepL API Key |
| `mic.html/js` | 獨立分頁：擷取「電腦麥克風」的聲音，即時逐字稿並翻譯（與分頁字幕共用同一組 API Key） |

## 兩種使用模式

1. **分頁字幕（浮動字幕）**：擷取「目前分頁播放的聲音」（YouTube、Twitch 等），字幕以可拖曳浮動框顯示在該網頁上。從外掛 popup 操作。
2. **麥克風翻譯（獨立頁面）**：擷取「電腦麥克風」收到的聲音（例如現場演講、會議、面對面對話），在一個獨立分頁中即時顯示逐字稿與翻譯。從 popup 的「🎙️ 開啟麥克風翻譯頁面」按鈕進入；首次使用會跳出麥克風權限請求。

## 安裝方式（開發者模式載入）

1. 打開 Chrome，前往 `chrome://extensions`
2. 右上角開啟「開發人員模式」
3. 點「載入未封裝項目」，選擇這個資料夾（`即時翻譯工具`）
4. 點擴充功能圖示旁的「⋮」→「選項」，輸入你的 API Key：
   - **Deepgram API Key**：至 [console.deepgram.com](https://console.deepgram.com/) 註冊，新帳號通常有免費額度
   - **DeepL API Key**：至 [deepl.com/pro-api](https://www.deepl.com/pro-api) 申請，Free 方案的金鑰通常以 `:fx` 結尾（記得選對 Free/Pro）
5. **分頁字幕**：開一個 YouTube 直播或 Twitch 分頁，點擴充功能圖示，選擇原始語言 / 翻譯目標語言，按「開始聆聽並翻譯」
6. **麥克風翻譯**：在 popup 按「🎙️ 開啟麥克風翻譯頁面」，於新分頁選好語言後按「開始聆聽」，並允許麥克風權限

## 使用限制與注意事項

- **DRM 保護的網站無法擷取**：Netflix、Disney+ 等使用加密媒體輸出的網站會擋下 `tabCapture`，此功能主要適用於 YouTube、Twitch 這類未加密輸出音訊的網站。
- **需要使用者手動點擊才能啟動**：`chrome.tabCapture` 要求使用者手勢（點擊擴充功能圖示），無法在背景自動啟動。
- **API 為付費/有額度限制的服務**：Deepgram、DeepL 都是需要自行申請 Key 的第三方服務，實際使用會依用量計費，請留意各自的免費額度與計費規則。
- **金鑰儲存位置**：API Key 儲存在 `chrome.storage.sync`，會跟著你登入的 Google 帳號在各台電腦間自動同步（需開啟 Chrome 同步）；除此之外不會上傳到任何其他第三方伺服器。若不希望同步，可關閉 Chrome 的擴充功能同步。UI 偏好（字幕位置、字體、句數等）仍存在各機器本機的 `chrome.storage.local`。本擴充功能本身不會攔截或紀錄你的音訊或文字內容。
- **在其他電腦使用**：把整個資料夾複製過去，於 `chrome://extensions` 開發者模式「載入未封裝項目」即可；只要各台電腦登入同一個 Google 帳號並開啟 Chrome 同步，API Key 會自動帶過去，不需重新輸入。
- **需要手動指定原始語言**：Deepgram 的自動語言偵測（`detect_language`）只支援「預錄音檔」，即時串流模式並不支援，因此必須在 popup 先選好直播的原始語言，字幕才會正常出現。
- **語言支援**：Deepgram 的語言代碼與 DeepL 的語言代碼不完全相同，`popup.html` 中已預先對應好幾種常見語言；如需更多語言，可在 `popup.html` 的 `<select>` 中比照 [Deepgram 語言列表](https://developers.deepgram.com/docs/models-languages-overview) 與 [DeepL 語言列表](https://developers.deepl.com/docs/resources/supported-languages) 增加選項。
- **喇叭仍會正常出聲**：`offscreen.js` 會把擷取到的音訊接回 `AudioContext.destination`，所以開字幕功能不會讓分頁靜音。

## 已知可再優化的方向

- 目前每個瀏覽器視窗同時間只支援擷取一個分頁；如需同時看多個直播字幕，需要擴充 `activeSession` 為依 tabId 索引的多重 session。
- Deepgram WebSocket 在閒置一段時間後會被伺服器關閉，`offscreen.js` 已加上簡單的自動重連機制（非使用者主動停止時），實務上長時間開台建議留意重連是否順暢。
- 字幕目前僅在收到 `is_final` 句子後才顯示翻譯，若想要「原文即時滾動、翻譯稍微延遲」以外的呈現方式（例如逐字捲動字幕），可以在 `content.js` 的 `TRANSCRIPT_UPDATE` 處理邏輯調整顯示策略。
