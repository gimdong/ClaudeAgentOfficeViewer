/* office 테마 색(make-scene.mjs가 씀). 원본 mock/tokens.js와 같은 값 */
/* Phase 7 Office 테마 — 낮(day)·밤(night) 값.
 * PAL = 장면 시트 안의 색(그림 속, 대비 검사 대상 아님). TH = 계약 SPEC §4 --th-* 이름 → PAL 키. TH_PROPOSED = 계약에 더하자고 제안하는 이름.
 * 목업은 PAL을 --sc-<키>로도 내보낸다(구현 때는 scene.png 안에 굽는 색). 공통 UI 토큰(--ink --panel …)은 여기서 정하지 않는다. */
const PAL = {
  day: {
    /* 바깥(themes 몫 — 목업 자리 채움 값) */
    skyTop: "#7cc8f2", skyMid: "#a8dcf7", skyLow: "#d6f0fb", sun: "#fff3b0", sunCore: "#ffe066",
    cloud: "#ffffff", cloudShade: "#dcecf6",
    cityFar: "#b9cfe0", cityFarWin: "#d5e4ef", cityNear: "#8eaac4", cityNearWin: "#c3d6e6",
    tree: "#57b46a", treeDark: "#3d8f50", trunk: "#7a5a3c",
    sidewalk: "#d9d2c5", sidewalkSeam: "#c4bcad", curb: "#a89f90",
    road: "#555963", roadEdge: "#474a53", lane: "#f3efe4", lamp: "#6b7080", lampLight: "#fff7d6",
    /* 겉벽·층 */
    shell: "#efe9dd", shellLight: "#fbf8f1", shellShade: "#d8d0c0", frame: "#b8ad99", slab: "#8c8273",
    winFrame: "#9aa7b4", glass: "#bfe3f5", glassShine: "#e8f7fd",
    wall: "#f7f4ee", wallStripe: "#eeeadf", baseboard: "#bcae97",
    tile: "#ddd4c4", tileAlt: "#d3c9b7", tileSeam: "#c2b7a3",
    ceilLight: "#fffdf2", ceilGlow: "rgba(255,250,215,.35)",
    teamZone: "#cfe3d6", teamZoneEdge: "#8fb8a0", partition: "#c9d3dc", partitionTop: "#e8eef3", partitionShade: "#a7b3bf",
    shaft: "#cfd5de", shaftDark: "#aab3c0", cab: "#e9edf2", cabDoor: "#b7c0cc", cable: "#7c8594",
    /* 가구 */
    deskTop: "#d2a776", deskFront: "#b3875a", deskLeg: "#8e6842", deskShadow: "rgba(70,50,30,.18)",
    chair: "#4f6286", chairDark: "#3a4867", chairLead: "#6a4a8a", chairLeadDark: "#4e3468", pennant: "#e0a92a",
    bezel: "#2d313c", bezelHi: "#4a5060", screenWork: "#13323d", screenRest: "#1d2130", screenAsk: "#3a3412", screenOff: "#0c0d12",
    codeGreen: "#2fd39a", codeCyan: "#3fb6ea", codeViolet: "#a184f0", led: "#2fd39a", ask: "#ffd84a",
    keyboard: "#e3e6ec", keyRow: "#a9afbd", mug: "#ffffff", mugShade: "#d9dde6", plant: "#4fb36b", pot: "#c8764a", memo: "#ffe98a",
    sofa: "#e0876a", sofaDark: "#b9654c", coffee: "#4a3a33",
    /* 카페·로비·옥상 */
    cafeWall: "#f4e4c9", cafeStripe: "#ead6b4", cafeTile: "#c98a5e", cafeTileAlt: "#b87a50", counter: "#8a5a3b", counterTop: "#e9dcc7", awning: "#2f9c7a", awningAlt: "#f7f4ee", menu: "#5b6078",
    lobbyWall: "#ece8e1", marble: "#e6e2da", marbleAlt: "#d8d3ca", marbleVein: "#c8c1b5", door: "#cfe9f5", doorFrame: "#6f7a88", booth: "#b8c4d2", boothDark: "#8e9bad", mat: "#5e6672",
    roofDeck: "#b9b2a5", roofDeckAlt: "#ada597", parapet: "#d8d0c0", rail: "#6f7a88", tank: "#9fb4c8", tankDark: "#7d93a8", ac: "#c7ccd4", acDark: "#9aa1ad", planter: "#9a6b45", antennaLight: "#e0463c",
    /* 층마다 벽지 변형(room-wall 시트 행 1–3; 0은 --th-wall 줄무늬) · 공사 중 층 */
    wallV1: "#eef6f0", wallV1b: "#d6eadc", wallV2: "#f2effa", wallV2b: "#ddd5f0", wallV3: "#fbf0e6", wallV3b: "#ecd8c4",
    clockFace: "#ffffff", board: "#ffffff", boardFrame: "#9aa7b4", frameWood: "#a8794e", art1: "#7cc8f2", art2: "#57b46a", book1: "#d84a4a", book2: "#3f8fd0", book3: "#e8b83a",
    concrete: "#d9d6d0", concreteLine: "#c4c0b8", caution: "#ffd84a", cautionDark: "#2b2638", cone: "#f0702c", coneBand: "#ffffff", scaffold: "#8a96a8", bulb: "#fff3b0",
    outline: "#2b2638",
    /* 장면 위 글자 판 */
    tagBg: "#ffffff", hudBorder: "#c9c0b0", ink: "#1f2233", muted: "#555b73",
    labelAccent: "#0b7a52", paper: "#f4f0dc", paperInk: "#1f2233", // 계약 §4.2·§6(로비 2F ▲, 보고서 종이) — developer T2에서 더함
    page: "#d6f0fb",
  },
  night: {
    skyTop: "#0b0a1a", skyMid: "#15133a", skyLow: "#2a2456", sun: "#e8e4ff", sunCore: "#c9c3f0",
    cloud: "#2c2852", cloudShade: "#221f44",
    cityFar: "#1b1a36", cityFarWin: "#ffd84a", cityNear: "#14132a", cityNearWin: "#fff7a8",
    tree: "#1f4a3a", treeDark: "#163628", trunk: "#3a2b22",
    sidewalk: "#3a3550", sidewalkSeam: "#2e2a44", curb: "#4a4468",
    road: "#1c1b2c", roadEdge: "#151423", lane: "#8c87ad", lamp: "#4a4468", lampLight: "#fff7a8",
    shell: "#2e2852", shellLight: "#4a4470", shellShade: "#241f40", frame: "#3b3460", slab: "#0b0a17",
    winFrame: "#3b3460", glass: "#1a1840", glassShine: "#2c2860",
    wall: "#1d1b33", wallStripe: "#22203b", baseboard: "#2a2446",
    tile: "#2a2446", tileAlt: "#26203f", tileSeam: "#1d1934",
    ceilLight: "#fff7a8", ceilGlow: "rgba(255,247,168,.12)",
    teamZone: "#22354a", teamZoneEdge: "#3a5a78", partition: "#2e2852", partitionTop: "#4a4470", partitionShade: "#1d1934",
    shaft: "#16142a", shaftDark: "#0e0d18", cab: "#3b3460", cabDoor: "#4a4470", cable: "#5d568f",
    deskTop: "#3b3460", deskFront: "#241f40", deskLeg: "#1a1630", deskShadow: "rgba(0,0,0,.35)",
    chair: "#4a4470", chairDark: "#2e2852", chairLead: "#5a3a7a", chairLeadDark: "#3a2452", pennant: "#ffd84a",
    bezel: "#0e0d18", bezelHi: "#2e2852", screenWork: "#0d2a2a", screenRest: "#141226", screenAsk: "#3a3412", screenOff: "#05050a",
    codeGreen: "#39ffb6", codeCyan: "#3fd0ff", codeViolet: "#b98cff", led: "#39ffb6", ask: "#fff7a8",
    keyboard: "#5d568f", keyRow: "#3b3460", mug: "#e8e4ff", mugShade: "#9d97c7", plant: "#2fa874", pot: "#7a4a36", memo: "#fff7a8",
    sofa: "#7a2a50", sofaDark: "#5a1f3c", coffee: "#2a201c",
    cafeWall: "#2a2140", cafeStripe: "#30264a", cafeTile: "#4a2f3a", cafeTileAlt: "#3f2832", counter: "#3a2630", counterTop: "#5d568f", awning: "#1f6b56", awningAlt: "#3b3460", menu: "#9d97c7",
    lobbyWall: "#24203e", marble: "#2a2446", marbleAlt: "#241f40", marbleVein: "#3b3460", door: "#2c2860", doorFrame: "#5d568f", booth: "#3b3460", boothDark: "#2e2852", mat: "#141226",
    roofDeck: "#2a2446", roofDeckAlt: "#241f40", parapet: "#3b3460", rail: "#5d568f", tank: "#3b3460", tankDark: "#2e2852", ac: "#4a4470", acDark: "#2e2852", planter: "#3a2b22", antennaLight: "#ff5a5a",
    wallV1: "#1a2430", wallV1b: "#22303f", wallV2: "#221d36", wallV2b: "#2c2546", wallV3: "#2a1f24", wallV3b: "#36282e",
    clockFace: "#c9c3f0", board: "#3b3460", boardFrame: "#5d568f", frameWood: "#4a3428", art1: "#3fd0ff", art2: "#2fa874", book1: "#c23c4a", book2: "#2a6fa0", book3: "#b89a30",
    concrete: "#2a2838", concreteLine: "#22202e", caution: "#ffd84a", cautionDark: "#0e0d18", cone: "#c0561e", coneBand: "#e8e4ff", scaffold: "#4a4470", bulb: "#fff7a8",
    outline: "#0e0d18",
    tagBg: "#0e0d18", hudBorder: "#3b3460", ink: "#e8e4ff", muted: "#9d97c7",
    labelAccent: "#39ffb6", paper: "#f4f0dc", paperInk: "#12111f",
    page: "#12111f",
  },
};
/* 계약 SPEC §4 이름 */
const TH = {
  "--th-bg": "page", "--th-sky-top": "skyTop", "--th-sky-bottom": "skyLow", "--th-sun": "sunCore",
  "--th-skyline-far": "cityFar", "--th-skyline-near": "cityNear",
  "--th-facade": "shell", "--th-facade-shade": "frame", "--th-facade-light": "shellLight",
  "--th-wall": "wall", "--th-wall-shade": "wallStripe", "--th-floor-a": "tile", "--th-floor-b": "tileAlt",
  "--th-desk": "deskFront", "--th-desk-top": "deskTop", "--th-window": "glass", "--th-light": "ceilLight",
  "--th-road": "road", "--th-road-line": "lane", "--th-sidewalk": "sidewalk",
  "--th-team-zone": "teamZone", "--th-accent-1": "awning", "--th-accent-2": "antennaLight", "--th-accent-3": "codeCyan",
  "--th-outline": "outline", "--th-label-bg": "tagBg", "--th-label-border": "hudBorder", "--th-label-ink": "ink",
};
/* 더하자고 제안하는 이름(NOTES.md §3) */
const TH_PROPOSED = {
  "--th-label-accent": "labelAccent", "--th-paper": "paper", "--th-paper-ink": "paperInk",
  "--th-label-muted": "muted", "--th-slab": "slab", "--th-shaft": "shaft", "--th-shaft-rail": "shaftDark",
  "--th-floor-edge": "baseboard", "--th-floor-seam": "tileSeam", "--th-team-zone-edge": "teamZoneEdge",
};
export { PAL, TH, TH_PROPOSED };
