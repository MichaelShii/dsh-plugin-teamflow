技术方案：本地持久化需独立 storage 封装，避免 game/audio 各自实现适配器。

<!-- blueprint -->{"summary":"抽独立 persist.js 封装 localStorage","modules":{"/persist.js":{"responsibility":"存储封装","dependsOn":[],"assemblyOrder":1,"why":"统一键名/默认值/解析器，避免重复适配器"}},"duplications":["game/audio 各自维护 storage 适配器"]},"tasks":[{"title":"T1 实现 persist.js","files":["/persist.js"],"spec":"按蓝图实现存储封装"},{"title":"T2 装配 audio/game","files":["/audio.js","/game.js"],"spec":"接入统一封装"}]}<!-- /blueprint -->
