import type {
  CoachingVerdict,
  ConfidenceLevel,
  DeliveryTip,
  Difficulty,
  InterviewMode,
  ReadinessBand,
  StarPart,
} from '@cbi/shared-types';
import type { OutputLanguage } from './language.js';

/**
 * Fixed report text in the candidate's output language: the fallback
 * recommendations (used when the recommendations model is unavailable) and
 * the PDF's headings and labels. `{name}` is a dimension name, kept as the
 * blueprint wrote it.
 */

export interface FallbackMessages {
  summaryScored: string;
  summaryUnscored: string;
  strength: string;
  gapLimited: string;
  gapUnassessed: string;
  examplesAction: string;
  examplesWhy: string;
  genericExamplesAction: string;
  genericExamplesWhy: string;
  starAction: string;
  starWhy: string;
  rehearseAction: string;
  rehearseWhy: string;
  retakeAction: string;
  retakeWhy: string;
}

const FALLBACK: Record<OutputLanguage, FallbackMessages> = {
  en: {
    summaryScored:
      'This summary is based on your scores. Focus first on the areas with the lowest scores below, then practise again to see your progress.',
    summaryUnscored:
      'There was not enough evidence in this interview to score most areas. Try a longer interview and answer with specific examples.',
    strength: 'Your answers showed solid evidence in {name}.',
    gapLimited: 'There was limited evidence of {name} in your answers.',
    gapUnassessed: '{name} could not be assessed from this interview.',
    examplesAction: 'Write down two specific examples from your work that show {name}.',
    examplesWhy: 'Concrete examples make answers about {name} convincing.',
    genericExamplesAction: 'Write down three specific examples from your recent work.',
    genericExamplesWhy: 'Concrete examples make interview answers convincing.',
    starAction:
      'Practise explaining {name} out loud using the situation, action and result structure.',
    starWhy: 'Structured answers show your reasoning and impact in {name}.',
    rehearseAction: 'Practise answering common questions for this role out loud.',
    rehearseWhy: 'Rehearsing builds fluency and structure.',
    retakeAction: 'Take another practice interview for this role and compare your results.',
    retakeWhy: 'Seeing your progress shows which areas still need work.',
  },
  hi: {
    summaryScored:
      'यह सारांश आपके स्कोर पर आधारित है। पहले नीचे सबसे कम स्कोर वाले क्षेत्रों पर ध्यान दें, फिर अपनी प्रगति देखने के लिए दोबारा अभ्यास करें।',
    summaryUnscored:
      'इस इंटरव्यू में ज़्यादातर क्षेत्रों का स्कोर देने के लिए पर्याप्त प्रमाण नहीं थे। लंबा इंटरव्यू आज़माएँ और ठोस उदाहरणों के साथ उत्तर दें।',
    strength: 'आपके उत्तरों में {name} के ठोस प्रमाण दिखे।',
    gapLimited: 'आपके उत्तरों में {name} के सीमित प्रमाण थे।',
    gapUnassessed: 'इस इंटरव्यू से {name} का आकलन नहीं हो सका।',
    examplesAction: 'अपने काम से दो ठोस उदाहरण लिखें जो {name} दिखाते हों।',
    examplesWhy: 'ठोस उदाहरण {name} के बारे में उत्तरों को भरोसेमंद बनाते हैं।',
    genericExamplesAction: 'अपने हाल के काम से तीन ठोस उदाहरण लिखें।',
    genericExamplesWhy: 'ठोस उदाहरण इंटरव्यू के उत्तरों को भरोसेमंद बनाते हैं।',
    starAction: 'स्थिति, कार्य और परिणाम के क्रम में {name} को बोलकर समझाने का अभ्यास करें।',
    starWhy: 'व्यवस्थित उत्तर {name} में आपकी सोच और प्रभाव दिखाते हैं।',
    rehearseAction: 'इस भूमिका के आम सवालों के जवाब बोलकर देने का अभ्यास करें।',
    rehearseWhy: 'अभ्यास से धाराप्रवाह और व्यवस्थित बोलना आता है।',
    retakeAction: 'इस भूमिका के लिए एक और अभ्यास इंटरव्यू दें और नतीजों की तुलना करें।',
    retakeWhy: 'अपनी प्रगति देखकर पता चलता है कि किन क्षेत्रों पर अभी काम करना है।',
  },
  te: {
    summaryScored:
      'ఈ సారాంశం మీ స్కోర్‌ల ఆధారంగా ఉంది. ముందుగా కింద తక్కువ స్కోర్ ఉన్న అంశాలపై దృష్టి పెట్టండి, తర్వాత మీ పురోగతి చూడటానికి మళ్లీ ప్రాక్టీస్ చేయండి.',
    summaryUnscored:
      'ఈ ఇంటర్వ్యూలో చాలా అంశాలకు స్కోర్ ఇవ్వడానికి సరిపడా ఆధారాలు లేవు. ఎక్కువ సమయం ఇంటర్వ్యూ ప్రయత్నించి, నిర్దిష్ట ఉదాహరణలతో సమాధానం ఇవ్వండి.',
    strength: 'మీ సమాధానాల్లో {name}కు బలమైన ఆధారాలు కనిపించాయి.',
    gapLimited: 'మీ సమాధానాల్లో {name}కు పరిమిత ఆధారాలు ఉన్నాయి.',
    gapUnassessed: 'ఈ ఇంటర్వ్యూ నుంచి {name}ను అంచనా వేయలేకపోయాం.',
    examplesAction: '{name}ను చూపించే మీ పనిలోని రెండు నిర్దిష్ట ఉదాహరణలు రాయండి.',
    examplesWhy: 'నిర్దిష్ట ఉదాహరణలు {name} గురించి సమాధానాలను నమ్మదగినవిగా చేస్తాయి.',
    genericExamplesAction: 'మీ ఇటీవలి పని నుంచి మూడు నిర్దిష్ట ఉదాహరణలు రాయండి.',
    genericExamplesWhy: 'నిర్దిష్ట ఉదాహరణలు ఇంటర్వ్యూ సమాధానాలను నమ్మదగినవిగా చేస్తాయి.',
    starAction: 'పరిస్థితి, చర్య, ఫలితం క్రమంలో {name}ను బయటకు చెప్పి వివరించడం ప్రాక్టీస్ చేయండి.',
    starWhy: 'క్రమబద్ధమైన సమాధానాలు {name}లో మీ ఆలోచనను, ప్రభావాన్ని చూపిస్తాయి.',
    rehearseAction:
      'ఈ పాత్రకు సాధారణంగా అడిగే ప్రశ్నలకు బయటకు చెప్పి సమాధానం ఇవ్వడం ప్రాక్టీస్ చేయండి.',
    rehearseWhy: 'ప్రాక్టీస్ చేయడం వల్ల ధారాళత, క్రమబద్ధత వస్తాయి.',
    retakeAction: 'ఈ పాత్ర కోసం మరో ప్రాక్టీస్ ఇంటర్వ్యూ చేసి మీ ఫలితాలను పోల్చండి.',
    retakeWhy: 'మీ పురోగతి చూస్తే ఇంకా ఏ అంశాలపై పని చేయాలో తెలుస్తుంది.',
  },
};

export function fallbackMessages(language: OutputLanguage): FallbackMessages {
  return FALLBACK[language] ?? FALLBACK.en;
}

export interface PdfMessages {
  title: string;
  /** "{title} at {company}". */
  atCompany: string;
  date: string;
  mode: string;
  duration: string;
  minutes: string;
  modes: Record<InterviewMode, string>;
  overall: string;
  noOverall: string;
  bands: Record<ReadinessBand, string>;
  confidence: string;
  confidenceLevels: Record<ConfidenceLevel, string>;
  dimensions: string;
  notAssessed: string;
  weight: string;
  strengths: string;
  gaps: string;
  plan: string;
  next24h: string;
  next3Days: string;
  next7Days: string;
  progress: string;
  previousOverall: string;
  coding: string;
  difficulties: Record<Difficulty, string>;
  judgeUnavailable: string;
  testsPassed: string;
  noSolution: string;
  notSubmitted: string;
  observations: string;
  noObservations: string;
  integrity: Record<string, string>;
  timeAway: string;
  integrityNote: string;
  disclaimer: string;
  /** "Better than {percentile}% of {sample} candidates practising for {role} (last {days} days)." */
  benchmark: string;
  answers: string;
  verdict: string;
  verdicts: Record<CoachingVerdict, string>;
  starParts: Record<StarPart, string>;
  /** "Structure (STAR): {covered}". */
  starLine: string;
  /** " - missing {missing}". */
  starMissing: string;
  starNone: string;
  worked: string;
  missingLabel: string;
  cover: string;
  example: string;
  /** "{complete} of {total} behavioural answers covered ...". */
  structureSummary: string;
  /** " Most often missing: {part}." */
  structureWeakest: string;
  delivery: string;
  /** Pace, fillers and hedging; {wpm} {min} {max} {fillers} {rate} {hedges}. */
  deliveryLine: string;
  /** "   Long pauses: {n}". */
  longPauses: string;
  /** Tips; {min} and {max} are the target pace. */
  deliveryTips: Record<DeliveryTip, string>;
  deliveryNote: string;
  /** Coding line suffix when the round allowed the AI assistant. */
  aiAssisted: string;
  systemDesign: string;
  aiCollaboration: string;
  panelNote: string;
  panelUnavailable: string;
  notScored: string;
}

const PDF: Record<OutputLanguage, PdfMessages> = {
  en: {
    title: 'Interview readiness report',
    atCompany: '{title} at {company}',
    date: 'Date',
    mode: 'Mode',
    duration: 'Duration',
    minutes: '{n} min',
    modes: { TEXT: 'text', VOICE: 'voice', VIDEO: 'video' },
    overall: 'Overall readiness',
    noOverall: 'No overall score',
    bands: {
      READY: 'Interview-ready',
      READY_WITH_GAPS: 'Interview-ready with gaps',
      DEVELOPING: 'Developing',
      NOT_YET: 'Not yet ready',
      INSUFFICIENT_EVIDENCE: 'Not enough evidence to score',
    },
    confidence: 'Evidence confidence',
    confidenceLevels: { HIGH: 'high', MEDIUM: 'medium', LOW: 'low' },
    dimensions: 'Dimensions',
    notAssessed: 'not assessed',
    weight: 'weight',
    strengths: 'Strengths',
    gaps: 'Gaps to work on',
    plan: 'Your plan',
    next24h: 'Next 24 hours',
    next3Days: 'Next 3 days',
    next7Days: 'Next 7 days',
    progress: 'Progress since your last attempt',
    previousOverall: 'Previous overall: {score} on {date}',
    coding: 'Coding',
    difficulties: { EASY: 'easy', MEDIUM: 'medium', HARD: 'hard' },
    judgeUnavailable: 'not run (the code judge was unavailable); reviewed from the code',
    testsPassed: '{passed} of {total} tests passed',
    noSolution: 'no solution',
    notSubmitted: 'not submitted before time ran out',
    observations: 'Session observations',
    noObservations: 'No browser events were noted.',
    integrity: {
      TAB_HIDDEN: 'Switched to another tab or app',
      WINDOW_BLUR: 'Interview window lost focus',
      FULLSCREEN_EXIT: 'Left full screen',
      PASTE: 'Pasted text into an answer',
      CAMERA_LOST: 'Camera stopped',
      MICROPHONE_LOST: 'Microphone stopped',
    },
    timeAway: 'Time away from the interview page: about {n} min',
    integrityNote:
      'These are browser events noted during the session. Most have ordinary explanations, such as a notification or a second screen. They are not part of the score.',
    disclaimer:
      'This report was generated by AI from your practice interview answers. It is an estimate to help you prepare, not a hiring decision or a guarantee of any outcome. Scores are based only on what you said in this interview.',
    benchmark:
      'Better than {percentile}% of {sample} candidates practising for {role} (last {days} days).',
    answers: 'Answer by answer',
    verdict: 'Verdict',
    verdicts: {
      STRONG: 'Strong',
      ADEQUATE: 'Adequate',
      WEAK: 'Needs work',
      UNASSESSED: 'Not assessed',
    },
    starParts: { situation: 'Situation', task: 'Task', action: 'Action', result: 'Result' },
    starLine: 'Structure (STAR): {covered}',
    starMissing: ' - missing {missing}',
    starNone: 'none',
    worked: 'Worked',
    missingLabel: 'Missing',
    cover: 'Cover',
    example: 'Example answer (built from your own answer)',
    structureSummary:
      'Structure: {complete} of {total} behavioural answers covered situation, task, action and result.',
    structureWeakest: ' Most often missing: {part}.',
    delivery: 'Delivery (spoken answers)',
    deliveryLine:
      'Pace: {wpm} words per minute (target {min}-{max})   Filler words: {fillers} ({rate} per 100 words)   Hedging phrases: {hedges}',
    longPauses: '   Long pauses: {n}',
    deliveryTips: {
      PACE_FAST:
        'Slow down a little: aim for {min}-{max} words per minute and pause briefly after key points.',
      PACE_SLOW:
        'Pick up the pace a little: aim for {min}-{max} words per minute by outlining your answer before you start.',
      FILLERS: 'Replace filler words with a short silent pause; it sounds more confident.',
      PAUSES:
        'Long pauses are fine for thinking; say "let me think for a moment" so the silence is clearly yours.',
      HEDGING: 'State what you did plainly ("I led", "I decided") instead of "I think" or "maybe".',
    },
    deliveryNote:
      'Delivery is coaching only and never affects your scores: pace and filler words vary with accent, language and speech differences.',
    aiAssisted: 'AI assistant allowed',
    systemDesign: 'System design',
    aiCollaboration: 'AI collaboration',
    panelNote:
      'Assessed separately from the dimensions above; not part of the overall readiness score.',
    panelUnavailable: 'The assessment model was unavailable, so this part was not scored.',
    notScored: 'Not scored',
  },
  hi: {
    title: 'इंटरव्यू रेडीनेस रिपोर्ट',
    atCompany: '{company} में {title}',
    date: 'तारीख़',
    mode: 'मोड',
    duration: 'अवधि',
    minutes: '{n} मिनट',
    modes: { TEXT: 'टेक्स्ट', VOICE: 'आवाज़', VIDEO: 'वीडियो' },
    overall: 'कुल तैयारी',
    noOverall: 'कोई कुल स्कोर नहीं',
    bands: {
      READY: 'इंटरव्यू के लिए तैयार',
      READY_WITH_GAPS: 'कुछ कमियों के साथ इंटरव्यू के लिए तैयार',
      DEVELOPING: 'विकसित हो रहे हैं',
      NOT_YET: 'अभी तैयार नहीं',
      INSUFFICIENT_EVIDENCE: 'स्कोर देने के लिए पर्याप्त प्रमाण नहीं',
    },
    confidence: 'प्रमाण पर भरोसा',
    confidenceLevels: { HIGH: 'उच्च', MEDIUM: 'मध्यम', LOW: 'कम' },
    dimensions: 'क्षेत्र',
    notAssessed: 'आकलन नहीं हुआ',
    weight: 'भार',
    strengths: 'मज़बूतियाँ',
    gaps: 'सुधार के क्षेत्र',
    plan: 'आपकी योजना',
    next24h: 'अगले 24 घंटे',
    next3Days: 'अगले 3 दिन',
    next7Days: 'अगले 7 दिन',
    progress: 'पिछले प्रयास से प्रगति',
    previousOverall: 'पिछला कुल स्कोर: {score} ({date})',
    coding: 'कोडिंग',
    difficulties: { EASY: 'आसान', MEDIUM: 'मध्यम', HARD: 'कठिन' },
    judgeUnavailable: 'नहीं चलाया गया (कोड जज उपलब्ध नहीं था); कोड देखकर समीक्षा की गई',
    testsPassed: '{total} में से {passed} टेस्ट पास हुए',
    noSolution: 'कोई समाधान नहीं',
    notSubmitted: 'समय ख़त्म होने से पहले जमा नहीं हुआ',
    observations: 'सत्र के दौरान देखी गई बातें',
    noObservations: 'ब्राउज़र की कोई घटना दर्ज नहीं हुई।',
    integrity: {
      TAB_HIDDEN: 'दूसरे टैब या ऐप पर गए',
      WINDOW_BLUR: 'इंटरव्यू विंडो से फ़ोकस हटा',
      FULLSCREEN_EXIT: 'फ़ुल स्क्रीन से बाहर निकले',
      PASTE: 'उत्तर में टेक्स्ट पेस्ट किया',
      CAMERA_LOST: 'कैमरा बंद हुआ',
      MICROPHONE_LOST: 'माइक्रोफ़ोन बंद हुआ',
    },
    timeAway: 'इंटरव्यू पेज से दूर बिताया समय: लगभग {n} मिनट',
    integrityNote:
      'ये सत्र के दौरान दर्ज की गई ब्राउज़र घटनाएँ हैं। ज़्यादातर के सामान्य कारण होते हैं, जैसे कोई सूचना या दूसरी स्क्रीन। ये स्कोर का हिस्सा नहीं हैं।',
    disclaimer:
      'यह रिपोर्ट आपके अभ्यास इंटरव्यू के उत्तरों से AI ने बनाई है। यह तैयारी में मदद के लिए एक अनुमान है, भर्ती का फ़ैसला या किसी नतीजे की गारंटी नहीं। स्कोर सिर्फ़ इस इंटरव्यू में आपकी कही बातों पर आधारित हैं।',
    benchmark:
      'पिछले {days} दिनों में {role} के लिए अभ्यास कर रहे {sample} उम्मीदवारों में से {percentile}% से बेहतर।',
    answers: 'हर उत्तर पर राय',
    verdict: 'आकलन',
    verdicts: {
      STRONG: 'मज़बूत',
      ADEQUATE: 'ठीक-ठाक',
      WEAK: 'सुधार चाहिए',
      UNASSESSED: 'आकलन नहीं हुआ',
    },
    starParts: { situation: 'स्थिति', task: 'ज़िम्मेदारी', action: 'कदम', result: 'नतीजा' },
    starLine: 'ढाँचा (STAR): {covered}',
    starMissing: ' - छूटा: {missing}',
    starNone: 'कुछ नहीं',
    worked: 'अच्छा रहा',
    missingLabel: 'छूट गया',
    cover: 'शामिल करें',
    example: 'उदाहरण उत्तर (आपके अपने उत्तर से बना)',
    structureSummary:
      'ढाँचा: {total} व्यवहार-संबंधी उत्तरों में से {complete} में स्थिति, ज़िम्मेदारी, कदम और नतीजा चारों थे।',
    structureWeakest: ' सबसे अधिक छूटा: {part}।',
    delivery: 'बोलने का तरीका (बोले गए उत्तर)',
    deliveryLine:
      'गति: {wpm} शब्द प्रति मिनट (लक्ष्य {min}-{max})   भराव शब्द: {fillers} (हर 100 शब्दों में {rate})   झिझक वाले वाक्यांश: {hedges}',
    longPauses: '   लंबे विराम: {n}',
    deliveryTips: {
      PACE_FAST:
        'थोड़ा धीमे बोलें: {min}-{max} शब्द प्रति मिनट का लक्ष्य रखें और मुख्य बातों के बाद ज़रा रुकें।',
      PACE_SLOW:
        'थोड़ा तेज़ बोलें: शुरू करने से पहले उत्तर की रूपरेखा सोच लें और {min}-{max} शब्द प्रति मिनट का लक्ष्य रखें।',
      FILLERS: 'भराव शब्दों की जगह छोटा-सा चुप विराम लें; इससे आप ज़्यादा आत्मविश्वासी लगते हैं।',
      PAUSES:
        'सोचने के लिए लंबा विराम ठीक है; "एक पल सोचने दीजिए" कहें ताकि साफ़ रहे कि आप सोच रहे हैं।',
      HEDGING:
        '"शायद" या "मुझे लगता है" की जगह सीधे बताएँ कि आपने क्या किया ("मैंने नेतृत्व किया", "मैंने तय किया")।',
    },
    deliveryNote:
      'बोलने का तरीका सिर्फ़ सलाह के लिए है और आपके स्कोर पर कभी असर नहीं डालता: गति और भराव शब्द लहजे, भाषा और बोलने के अंतर के साथ बदलते हैं।',
    aiAssisted: 'AI सहायक की अनुमति थी',
    systemDesign: 'सिस्टम डिज़ाइन',
    aiCollaboration: 'AI के साथ काम',
    panelNote: 'ऊपर के क्षेत्रों से अलग आँका गया; कुल तैयारी स्कोर का हिस्सा नहीं।',
    panelUnavailable: 'आकलन मॉडल उपलब्ध नहीं था, इसलिए इस हिस्से का स्कोर नहीं दिया गया।',
    notScored: 'स्कोर नहीं दिया गया',
  },
  te: {
    title: 'ఇంటర్వ్యూ సంసిద్ధత నివేదిక',
    atCompany: '{company}లో {title}',
    date: 'తేదీ',
    mode: 'విధానం',
    duration: 'వ్యవధి',
    minutes: '{n} నిమి',
    modes: { TEXT: 'టెక్స్ట్', VOICE: 'వాయిస్', VIDEO: 'వీడియో' },
    overall: 'మొత్తం సంసిద్ధత',
    noOverall: 'మొత్తం స్కోర్ లేదు',
    bands: {
      READY: 'ఇంటర్వ్యూకి సిద్ధం',
      READY_WITH_GAPS: 'కొన్ని లోపాలతో ఇంటర్వ్యూకి సిద్ధం',
      DEVELOPING: 'అభివృద్ధి చెందుతోంది',
      NOT_YET: 'ఇంకా సిద్ధం కాలేదు',
      INSUFFICIENT_EVIDENCE: 'స్కోర్ ఇవ్వడానికి సరిపడా ఆధారాలు లేవు',
    },
    confidence: 'ఆధారాలపై నమ్మకం',
    confidenceLevels: { HIGH: 'అధికం', MEDIUM: 'మధ్యస్థం', LOW: 'తక్కువ' },
    dimensions: 'అంశాలు',
    notAssessed: 'అంచనా వేయలేదు',
    weight: 'ప్రాధాన్యత',
    strengths: 'బలాలు',
    gaps: 'మెరుగుపరచుకోవాల్సిన అంశాలు',
    plan: 'మీ ప్రణాళిక',
    next24h: 'తదుపరి 24 గంటలు',
    next3Days: 'తదుపరి 3 రోజులు',
    next7Days: 'తదుపరి 7 రోజులు',
    progress: 'మీ గత ప్రయత్నం నుంచి పురోగతి',
    previousOverall: 'గత మొత్తం స్కోర్: {score} ({date})',
    coding: 'కోడింగ్',
    difficulties: { EASY: 'సులభం', MEDIUM: 'మధ్యస్థం', HARD: 'కష్టం' },
    judgeUnavailable: 'అమలు చేయలేదు (కోడ్ జడ్జ్ అందుబాటులో లేదు); కోడ్ చూసి సమీక్షించాం',
    testsPassed: '{total}లో {passed} టెస్ట్‌లు పాస్ అయ్యాయి',
    noSolution: 'పరిష్కారం లేదు',
    notSubmitted: 'సమయం ముగిసేలోపు సమర్పించలేదు',
    observations: 'సెషన్ సమయంలో గమనించినవి',
    noObservations: 'బ్రౌజర్ ఈవెంట్‌లు ఏవీ నమోదు కాలేదు.',
    integrity: {
      TAB_HIDDEN: 'మరో ట్యాబ్ లేదా యాప్‌కి మారారు',
      WINDOW_BLUR: 'ఇంటర్వ్యూ విండో నుంచి ఫోకస్ తప్పింది',
      FULLSCREEN_EXIT: 'ఫుల్ స్క్రీన్ నుంచి బయటకు వచ్చారు',
      PASTE: 'సమాధానంలో టెక్స్ట్ పేస్ట్ చేశారు',
      CAMERA_LOST: 'కెమెరా ఆగిపోయింది',
      MICROPHONE_LOST: 'మైక్రోఫోన్ ఆగిపోయింది',
    },
    timeAway: 'ఇంటర్వ్యూ పేజీ నుంచి దూరంగా ఉన్న సమయం: సుమారు {n} నిమి',
    integrityNote:
      'ఇవి సెషన్ సమయంలో నమోదైన బ్రౌజర్ ఈవెంట్‌లు. చాలా వాటికి సాధారణ కారణాలు ఉంటాయి, ఉదాహరణకు నోటిఫికేషన్ లేదా రెండో స్క్రీన్. ఇవి స్కోర్‌లో భాగం కావు.',
    disclaimer:
      'ఈ నివేదికను మీ ప్రాక్టీస్ ఇంటర్వ్యూ సమాధానాల నుంచి AI రూపొందించింది. ఇది సిద్ధం కావడానికి సహాయపడే అంచనా మాత్రమే, నియామక నిర్ణయం లేదా ఏ ఫలితానికీ హామీ కాదు. స్కోర్‌లు ఈ ఇంటర్వ్యూలో మీరు చెప్పినదాని ఆధారంగా మాత్రమే ఉన్నాయి.',
    benchmark:
      'గత {days} రోజుల్లో {role} కోసం ప్రాక్టీస్ చేస్తున్న {sample} మంది అభ్యర్థుల్లో {percentile}% కంటే మెరుగ్గా ఉన్నారు.',
    answers: 'ప్రతి సమాధానంపై అభిప్రాయం',
    verdict: 'అంచనా',
    verdicts: {
      STRONG: 'బలంగా ఉంది',
      ADEQUATE: 'సరిపోతుంది',
      WEAK: 'మెరుగుపడాలి',
      UNASSESSED: 'అంచనా వేయలేదు',
    },
    starParts: { situation: 'సందర్భం', task: 'బాధ్యత', action: 'చర్య', result: 'ఫలితం' },
    starLine: 'నిర్మాణం (STAR): {covered}',
    starMissing: ' - లేనివి: {missing}',
    starNone: 'ఏమీ లేదు',
    worked: 'బాగుంది',
    missingLabel: 'లేదు',
    cover: 'చేర్చండి',
    example: 'ఉదాహరణ సమాధానం (మీ సొంత సమాధానం నుంచి రూపొందించింది)',
    structureSummary:
      'నిర్మాణం: {total} ప్రవర్తన సంబంధిత సమాధానాల్లో {complete}లో సందర్భం, బాధ్యత, చర్య, ఫలితం నాలుగూ ఉన్నాయి.',
    structureWeakest: ' ఎక్కువగా లేనిది: {part}.',
    delivery: 'మాట్లాడే తీరు (మాట్లాడిన సమాధానాలు)',
    deliveryLine:
      'వేగం: నిమిషానికి {wpm} పదాలు (లక్ష్యం {min}-{max})   పూరక పదాలు: {fillers} (ప్రతి 100 పదాలకు {rate})   సందేహపు మాటలు: {hedges}',
    longPauses: '   సుదీర్ఘ విరామాలు: {n}',
    deliveryTips: {
      PACE_FAST:
        'కొంచెం నెమ్మదిగా మాట్లాడండి: నిమిషానికి {min}-{max} పదాలు లక్ష్యంగా పెట్టుకుని, ముఖ్యమైన విషయాల తర్వాత కాస్త ఆగండి.',
      PACE_SLOW:
        'కొంచెం వేగంగా మాట్లాడండి: మొదలుపెట్టే ముందు సమాధానం రూపురేఖ ఆలోచించుకుని, నిమిషానికి {min}-{max} పదాలు లక్ష్యంగా పెట్టుకోండి.',
      FILLERS:
        'పూరక పదాల బదులు చిన్న నిశ్శబ్ద విరామం తీసుకోండి; అది మరింత ఆత్మవిశ్వాసంగా వినిపిస్తుంది.',
      PAUSES:
        'ఆలోచించడానికి సుదీర్ఘ విరామం పర్వాలేదు; "ఒక్క క్షణం ఆలోచిస్తాను" అని చెప్పండి, అప్పుడు ఆ నిశ్శబ్దం మీదేనని స్పష్టంగా ఉంటుంది.',
      HEDGING:
        '"బహుశా", "నాకు అనిపిస్తుంది" బదులు మీరు ఏం చేశారో నేరుగా చెప్పండి ("నేను నడిపించాను", "నేను నిర్ణయించాను").',
    },
    deliveryNote:
      'మాట్లాడే తీరు కేవలం సలహా కోసమే, మీ స్కోర్‌పై ఎప్పుడూ ప్రభావం చూపదు: వేగం, పూరక పదాలు యాస, భాష, మాట్లాడే తేడాలతో మారుతుంటాయి.',
    aiAssisted: 'AI సహాయకుడికి అనుమతి ఉంది',
    systemDesign: 'సిస్టమ్ డిజైన్',
    aiCollaboration: 'AIతో కలిసి పని',
    panelNote: 'పై అంశాల నుంచి వేరుగా అంచనా వేశాం; మొత్తం సంసిద్ధత స్కోర్‌లో భాగం కాదు.',
    panelUnavailable: 'అంచనా మోడల్ అందుబాటులో లేదు, కాబట్టి ఈ భాగానికి స్కోర్ ఇవ్వలేదు.',
    notScored: 'స్కోర్ ఇవ్వలేదు',
  },
};

export function pdfMessages(language: OutputLanguage): PdfMessages {
  return PDF[language] ?? PDF.en;
}

/** Fills `{key}` placeholders. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, key: string) =>
    key in values ? String(values[key]) : m,
  );
}
