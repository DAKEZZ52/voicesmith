/**
 * 常见翻唱曲目的音域（约值，MIDI 音高）
 * low/high 是主旋律的常用音域，不含极端花腔
 */
export const SONGS = [
  { name: '后来', artist: '刘若英', low: 57, high: 76, style: '女声抒情·轻声' },
  { name: '赤伶', artist: 'HITA', low: 59, high: 83, style: '古风·高音' },
  { name: '画心', artist: '张靓颖', low: 57, high: 77, style: '古风·抒情' },
  { name: '会呼吸的痛', artist: '梁静茹', low: 55, high: 74, style: '女声抒情' },
  { name: '至少还有你', artist: '林忆莲', low: 57, high: 77, style: '女声慢歌' },
  { name: '匆匆那年', artist: '王菲', low: 54, high: 73, style: '女声叙事' },
  { name: '月亮代表我的心', artist: '邓丽君', low: 53, high: 72, style: '老情歌' },
  { name: '甜蜜蜜', artist: '邓丽君', low: 55, high: 69, style: '老情歌·轻快' },
  { name: '天空之城（女声版）', artist: '久石让', low: 55, high: 77, style: '治愈·高音' },
  { name: '泡沫', artist: '邓紫棋', low: 64, high: 88, style: '高音·难度大' },
  { name: '左手指月', artist: '萨顶顶', low: 65, high: 84, style: '高音·古风' },
  { name: '光年之外', artist: '邓紫棋', low: 62, high: 86, style: '高音·流行' },
  { name: '微光', artist: '蔚雨芯', low: 48, high: 69, style: '低音·气声' },
  { name: '成都', artist: '赵雷', low: 43, high: 62, style: '男声民谣' },
  { name: '演员', artist: '薛之谦', low: 43, high: 64, style: '男声情歌' },
  { name: '稻香', artist: '周杰伦', low: 55, high: 74, style: '男声民谣' },
  { name: '一千年以后', artist: '林俊杰', low: 45, high: 69, style: '男声高音' },
  { name: '南山南', artist: '马頔', low: 45, high: 64, style: '民谣·低音' },
];

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function midiToNote(m) {
  const n = Math.round(m);
  return NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);
}

/**
 * 给一首歌建议变调：
 * 优先 0；不行就在 ±6 内找最小移动，让整首歌落进舒适区
 */
export function suggestShift(song, lowMidi, highMidi) {
  for (let shift = 0; shift <= 6; shift += 1) {
    for (const s of shift === 0 ? [0] : [shift, -shift]) {
      const lo = song.low + s;
      const hi = song.high + s;
      if (lo >= lowMidi && hi <= highMidi) return { shift: s, fits: true };
    }
  }
  // 超过 6 个半音就不建议硬变调了，直接判不搭
  return { shift: 0, fits: false };
}
