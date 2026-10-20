# 手部測試影像（只給自動測試用，不隨遊戲提供）

用來驗證「真的模型推論」：把影像做成假鏡頭串流（Chromium `--use-file-for-fake-video-capture`），
讓 MediaPipe Hand Landmarker 在 worker 裡辨識。不是 iPhone 後鏡頭的實拍，也不是任何玩家或工作人員的照片。

| 檔案 | 來源 | 作者 | 授權 | 處理 |
|---|---|---|---|---|
| `open-palm.jpg` | Wikimedia Commons [File:Human Hand.JPG](https://commons.wikimedia.org/wiki/File:Human_Hand.JPG) | Jason Auerbach（Credit：Deonna Hodges） | Public domain | 縮小為 640×480 |
| `pinch.jpg` | Wikimedia Commons [File:Pinch-01.jpg](https://commons.wikimedia.org/wiki/File:Pinch-01.jpg) | Andrew Pertsev | CC0 1.0 | 縮小為 640×360 |

2026-10-20 經 Commons API（imageinfo / extmetadata）核對授權欄位。
