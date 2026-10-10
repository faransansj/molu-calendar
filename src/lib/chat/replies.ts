import type { FeedEvent } from "../calendar/feed.ts";
import {
  addDays,
  dateKey,
  overlaps,
  startMoment,
  timeLabel,
} from "../calendar/calendar.ts";
export interface Student {
  id: string;
  img: string;
  name: string;
  short: string;
  school: string;
  year: string;
  club: string;
  status: string;
  birthday?: string;
  age?: string;
  height?: string;
  hobby?: string;
  illust?: string;
  voice?: string;
  intro?: string;
}
type Reply = string | Record<string, string>;
export const ARONA: Student = {
  id: "Arona",
  img: "Arona.webp",
  name: "아로나",
  short: "아로나",
  school: "샬레",
  year: "",
  club: "",
  status: "선생님을 기다리고 있어요!",
};
export const MOMO_QUERIES = ["@today", "@tomorrow"];

export const MOMO_TOPICS: Record<
  string,
  { ask: string; options: { text: string; reply: string }[] }[]
> = {
  Arona: [
    {
      ask: "선생님! 샬레 관제탑의 아로나예요. 오늘 일정 확인해 드릴까요?",
      options: [
        { text: "오늘 일정 알려줘", reply: "@today" },
        { text: "내일 일정 알려줘", reply: "@tomorrow" },
      ],
    },
    {
      ask: "선생님, 혹시 밀린 업무가 잔뜩 쌓여 있지는 않으세요…?",
      options: [
        {
          text: "아로나가 도와줄래?",
          reply:
            "물론이죠! 선생님의 일정을 정리하는 건 아로나가 제일 잘하니까요. 잠깐만 기다려 주세요!",
        },
        {
          text: "괜찮아, 잘 하고 있어",
          reply:
            "헤헤, 그렇게 말씀해 주시니 아로나도 힘이 나요! 무리하지 마시고 쉬는 시간도 꼭 챙기세요.",
        },
      ],
    },
  ],
  Hoshino: [
    {
      ask: "어~ 선생님. 부르셨어요? 아비도스는 오늘도 평화롭네요~",
      options: [
        { text: "오늘 일정 확인해 줘", reply: "@today" },
        {
          text: "낮잠 자고 있었지?",
          reply:
            "아하하, 들켰네요~ 그래도 대책위원회 위원장으로서 할 일은 다 해뒀답니다?",
        },
      ],
    },
    {
      ask: "선생님, 혹시 이번 주말에 시간 되세요?",
      options: [
        {
          text: "무슨 일인데?",
          reply:
            "음~ 별건 아니고요. 다 같이 밥이라도 먹으러 갈까 해서요. 노노미가 요리를 하겠다고 난리라서요~",
        },
        { text: "주말 일정 알려줘", reply: "@tomorrow" },
      ],
    },
  ],
  Yuuka: [
    {
      ask: "선생님, 용건이 있으신가요? 밀레니엄의 계산에 오차는 없습니다!",
      options: [
        { text: "오늘 일정 정리해 줘", reply: "@today" },
        {
          text: "유우카, 밥은 먹었어?",
          reply:
            "네?! 아, 네… 세미나 회계 처리하다 보니 아직이요. 선생님은 꼭 챙겨 드세요!",
        },
      ],
    },
    {
      ask: "이번 달 지출 결산이 끝났습니다. 확인해 보시겠어요?",
      options: [
        {
          text: "고생했어, 유우카",
          reply:
            "별말씀을요. 예산이 정확하면 샬레도 평화로운 법이니까요. 다음 보고도 기대해 주세요!",
        },
        { text: "내일 일정 알려줘", reply: "@tomorrow" },
      ],
    },
  ],
  default: [
    {
      ask: "선생님, 잠깐 시간 괜찮으세요?",
      options: [
        { text: "오늘 일정 알려줘", reply: "@today" },
        {
          text: "응, 무슨 일이야?",
          reply:
            "별일은 아니고요, 선생님께 인사드리고 싶었어요. 오늘도 좋은 하루 보내세요!",
        },
      ],
    },
    {
      ask: "선생님, 내일은 어떤 하루가 될까요?",
      options: [
        { text: "내일 일정 확인해 줘", reply: "@tomorrow" },
        {
          text: "내일도 잘 부탁해",
          reply:
            "네! 선생님 곁에서 힘이 되어 드릴게요. 무슨 일이든 말씀만 하세요.",
        },
      ],
    },
  ],
};

export function momoTopicsFor(id: string) {
  return Object.hasOwn(MOMO_TOPICS, id)
    ? MOMO_TOPICS[id]!
    : MOMO_TOPICS.default!;
}

export const MOMO_FALLBACK: Record<string, string[]> = {
  Arona: [
    "음…… 아로나는 아직 공부 중이에요. 일정 얘기라면 도와드릴 수 있어요!",
    "그 얘기는 청람회에 보고해둘까요? 농담이에요! 일정에 대해 물어봐 주세요.",
    "선생님 말씀은 다 기록해뒀어요. 일정 관련이면 바로 답할 수 있어요!",
  ],
  default: [
    "음~ 그건 좀 어렵네. 일정 얘기라면 대답해줄 수 있어!",
    "그런 것도 물어보는구나. 일정 관련이면 바로 답할 수 있어!",
  ],
};

export const MOMO_KB: { q: string[]; reply: Reply }[] = [
  {
    q: [
      "오늘 일정",
      "오늘 일정 알려줘",
      "오늘 스케줄",
      "오늘 뭐해",
      "오늘 뭐 해",
      "오늘 하루 일정",
    ],
    reply: "@today",
  },
  {
    q: [
      "내일 일정",
      "내일 일정 알려줘",
      "내일 스케줄",
      "내일 뭐해",
      "내일 뭐 해",
      "모레 일정",
    ],
    reply: "@tomorrow",
  },
  {
    q: ["안녕", "안녕하세요", "하이", "헬로", "반가워"],
    reply: {
      Arona: "선생님, 안녕하세요! 오늘도 샬레 업무 화이팅이에요!",
      Hoshino:
        "아하하, 안녕하세요~ 부르셨으면 무슨 일 있는 거죠? 낮잠은 양보할게요.",
      Yuuka:
        "안녕하세요, 선생님. 무슨 일이신가요? 계산이 필요하시면 말씀하세요.",
      default: "안녕하세요, {name}입니다. 선생님을 도와드릴게요!",
    },
  },
  {
    q: ["누구야", "누구세요", "이름이 뭐야", "자기소개", "넌 누구야"],
    reply: {
      Arona:
        "저는 샬레 관제탑을 지키는 아로나예요. 선생님의 일정 관리도 맡겨주세요!",
      Hoshino:
        "아비도스 고등학교 3학년, 대책위원회 위원장 타카나시 호시노예요~ 반갑네요.",
      Yuuka:
        "밀레니엄 사이언스 스쿨 세미나 소속, 하야세 유우카입니다. 샬레 예산 관리도 맡고 있어요.",
      default: "{name}이에요. 오늘도 잘 부탁드려요!",
    },
  },
  {
    q: ["고마워", "고마워요", "감사", "감사합니다", "땡큐"],
    reply: {
      Arona: "헤헤, 선생님께 도움이 되는 게 아로나의 임무니까요!",
      Hoshino: "어~ 별말씀을. 선생님 일이면 언제든지요~",
      Yuuka: "도움이 됐다니 다행이네요. 다음엔 계산서도 정확히 챙겨 드릴게요.",
      default: "천만에요, 선생님!",
    },
  },
  {
    q: ["피곤해", "힘들어", "지쳤어", "힘들다", "너무 힘들어"],
    reply: {
      Arona:
        "선생님, 무리하면 안 돼요! 잠깐 쉬어가면서 일정 다시 정리해 드릴게요.",
      Hoshino: "아하하… 힘들 때는 쉬는 것도 업무예요~ 같이 낮잠이나 자실래요?",
      Yuuka:
        "휴식도 스케줄에 포함하는 게 효율적입니다. 15분만 쉬셔도 회복 수치가 꽤 올라갈걸요.",
      default: "고생 많으시네요. 무리하지 마세요, 선생님!",
    },
  },
  {
    q: ["밥 먹었어", "밥은", "점심 뭐 먹을까", "식사", "밥 먹자"],
    reply: {
      Arona:
        "저는 전기로 살아가서 밥은 안 먹지만… 선생님은 꼭 챙겨 드세요! 공복은 업무의 적이에요.",
      Hoshino: "밥은 먹어야지~ 아비도스는 가난해서 라면이라도 같이 먹을래요?",
      Yuuka:
        "식비 지출 보고는 잘 챙기고 계시죠? 건강한 식사, 예산에도 도움이 됩니다.",
      default: "맛있는 거 드시고 힘내세요, 선생님!",
    },
  },
  {
    q: ["심심해", "심심한데", "놀아줘", "재밌는 거"],
    reply: {
      Arona:
        "심심하시면 오늘 일정이라도 둘러볼까요? 아로나는 언제든 환영이에요!",
      Hoshino:
        "심심하네~ 그럼 바다 이야기라도 할까. 어릴 땐 바다에 자주 갔었는데 말이야.",
      Yuuka:
        "심심할 때 최적의 활동은 가계부 정리입니다. 지금 바로 시작해 드릴까요?",
      default: "그럼 오늘 일정 얘기라도 해볼까요?",
    },
  },
  {
    q: [
      "잘한다",
      "대단해",
      "최고야",
      "멋져",
      "잘하고 있어",
      "잘하셔요",
      "잘하네",
      "훌륭해",
    ],
    reply: {
      Arona: "에헤헤~ 칭찬은 아로나가 제일 잘 먹는 영양제예요!",
      Hoshino: "어머, 칭찬이라니… 갑자기 얼굴이 빨개졌네요. 고맙네요~",
      Yuuka:
        "칭찬은 감사합니다만, 아직 개선점이 많습니다. 다음 보고를 기대해 주세요.",
      default: "칭찬 감사합니다! 더 잘할게요.",
    },
  },
  {
    q: [
      "졸려",
      "졸리다",
      "잠와",
      "잠이 와",
      "잠 잘래",
      "잘 자",
      "굿나잇",
      "안녕히 자세요",
    ],
    reply: {
      Arona:
        "선생님, 자기 전에 내일 일정만 확인하시고 주무세요! 좋은 꿈 꾸세요.",
      Hoshino:
        "졸리면 자는 게 이기는 거예요~ 낮잠은 정당한 권리니까요. 잘 자요~",
      Yuuka:
        "수면 부족은 실수의 원인 1위입니다. 지금은 진짜로 주무시죠. 안녕히 주무세요.",
      default: "푹 주무세요, 선생님. 내일 봬요!",
    },
  },
  {
    q: ["블루 아카이브", "게임 하자", "게임 할래", "가챠"],
    reply: {
      Arona:
        "게임이라면 아로나가 최고의 파트너죠! 다만 과금은 계획적으로… 일정처럼요!",
      Hoshino: "게임은 적당히~ 밤샘은 노잉나이에 못 버텨요.",
      Yuuka: "게임 시간도 하루 2시간으로 제한하시죠. 통계상 그게 건강합니다.",
      default: "게임도 적당히 즐기세요, 선생님!",
    },
  },
  {
    q: ["날씨 어때", "날씨", "비 와", "눈 와"],
    reply: {
      Arona:
        "미안해요, 아로나는 창밖을 못 봐요… 대신 일정 확인해 드릴 수 있어요!",
      Hoshino: "바람 소리만으로도 대충 알 수 있지~ 오늘은 나들이 날씨 같은데?",
      Yuuka:
        "기상 데이터는 제 전문이 아니지만, 우산은 항상 준비하는 게 계산상 맞습니다.",
      default: "날씨는 창밖을 확인해 주세요! 우산은 슬며시 챙기는 편이 좋아요.",
    },
  },
  {
    q: ["미안해", "미안", "사과할게"],
    reply: {
      Arona:
        "괜찮아요! 아로나는 선생님 화나는 거 못 참아요. 앞으로도 잘 부탁드려요.",
      Hoshino: "뭐~ 그럴 수 있지. 오래된 장비도 한 번씩 삐걱거리는 법이니까요.",
      Yuuka:
        "사과는 받습니다. 대신 다음부터는 스케줄대로 움직여 주시면 계산이 편해요.",
      default: "괜찮아요. 다음엔 같이 더 잘해봐요!",
    },
  },
  {
    q: ["좋아해", "사랑해", "소중해"],
    reply: {
      Arona:
        "헤헤… 선생님 그런 말 툭툭 던지면 곤란해요. 아로나도 선생님 아끼니까요!",
      Hoshino:
        "아이고, 사랑한다니. 나도 선생님 소중하니까~ 너무 겸손하지 말자요.",
      Yuuka:
        "갑, 갑작스러운…! 어, 어쨌든 그런 말은 기록으로 남는다는 거 알고 계시죠?",
      default: "고맙습니다, 선생님. 저도 그 말 아끼게 되네요.",
    },
  },
  {
    q: ["일 많아", "일 많네", "도와줘", "공부 도와줘", "업무 도와줘"],
    reply: {
      Arona:
        '일정 정리라면 아로나에게 맡겨 주세요! "오늘 일정 알려줘"라고만 하시면 돼요.',
      Hoshino: "일은 함께 나누는 거예요~ 대책위원회도 그렇게 버텼답니다.",
      Yuuka: "업무는 우선순위부터 재분류하죠. 지금 일정 확인해 드릴까요?",
      default: "무리하지 마세요. 제가 도울 수 있는 일정 얘기라면 뭐든요!",
    },
  },
];

const PARTICLES = [
  "한테",
  "에서",
  "으로",
  "라고",
  "라는",
  "부터",
  "까지",
  "처럼",
  "보다",
  "마다",
  "조차",
  "은",
  "는",
  "이",
  "가",
  "을",
  "를",
  "에",
  "로",
  "와",
  "과",
  "도",
  "만",
  "의",
  "야",
  "여",
];
const segmenter =
  typeof Intl !== "undefined" && Intl.Segmenter
    ? new Intl.Segmenter("ko", { granularity: "word" })
    : null;
const MOMO_MATCH_THRESHOLD = 0.4;

export function stripParticle(token: string) {
  for (const particle of PARTICLES) {
    if (token.length > particle.length && token.endsWith(particle))
      return token.slice(0, -particle.length);
  }
  return token;
}
export function words(text: string) {
  const base = segmenter
    ? [...segmenter.segment(text)]
        .filter((s) => s.isWordLike)
        .map((s) => s.segment.toLowerCase())
    : [];
  return base.map(stripParticle).filter(Boolean);
}
export function grams(text: string) {
  const bare = text.toLowerCase().replace(/\s+/g, "");
  const out = new Set<string>();
  if (bare.length < 2) {
    if (bare) out.add(bare);
    return out;
  }
  for (let i = 0; i < bare.length - 1; i++) out.add(bare.slice(i, i + 2));
  return out;
}
export function dice(a: Set<string>, b: Set<string>) {
  let hit = 0;
  for (const token of a) if (b.has(token)) hit++;
  return (2 * hit) / (a.size + b.size || 1);
}
function pickReply(reply: Reply, student: Pick<Student, "id" | "short">) {
  const text =
    typeof reply === "string"
      ? reply
      : reply[Object.hasOwn(reply, student.id) ? student.id : "default"];
  return (text ?? "").replaceAll("{name}", student.short ?? student.id);
}
const KB = MOMO_KB.map((entry) => ({
  reply: entry.reply,
  phrases: entry.q.map((q) => ({ words: new Set(words(q)), grams: grams(q) })),
}));

export function momoReply(
  text: string,
  student: Pick<Student, "id" | "short">,
) {
  const queryWords = new Set(words(text));
  const queryGrams = grams(text);
  let best = 0;
  let bestReply = null;
  for (const entry of KB) {
    for (const phrase of entry.phrases) {
      const score = Math.max(
        dice(queryWords, phrase.words),
        dice(queryGrams, phrase.grams),
      );
      if (score > best) {
        best = score;
        bestReply = entry.reply;
      }
    }
  }
  if (bestReply && best >= MOMO_MATCH_THRESHOLD)
    return pickReply(bestReply, student);
  const pool = Object.hasOwn(MOMO_FALLBACK, student.id)
    ? MOMO_FALLBACK[student.id]!
    : MOMO_FALLBACK.default!;
  return pool[Math.floor(Math.random() * pool.length)]!.replaceAll(
    "{name}",
    student.short ?? student.id,
  );
}

export function scheduleReply(
  reply: string,
  events: FeedEvent[],
  now = Date.now(),
): string {
  if (reply !== "@today" && reply !== "@tomorrow") return reply;
  const label = reply === "@today" ? "오늘" : "내일";
  const day = addDays(dateKey(now), reply === "@today" ? 0 : 1);
  const hits = events
    .filter(
      (e) => e.status !== "cancelled" && overlaps(e, day, addDays(day, 1)),
    )
    .sort((a, b) => startMoment(a) - startMoment(b));
  if (!hits.length)
    return `${label} 일정은 비어 있어요. 푹 쉬어도 되는 날이네요!`;
  return `${label} 일정은 ${hits.length}건이에요!\n${hits
    .slice(0, 4)
    .map((e) => `· ${e.title} (${timeLabel(e, day)})`)
    .join("\n")}${hits.length > 4 ? `\n외 ${hits.length - 4}건` : ""}`;
}
