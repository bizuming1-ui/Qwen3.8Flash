package main

// Prosody planner / streaming segmenter.
//
// Turns a stream of LLM text deltas into "breath groups": segments that are cut at
// natural clause / sentence boundaries, the first one short (fast first audio), later ones
// longer (better prosody + GPU efficiency). Every segment carries the pause that a human
// would leave before it and whether a breath belongs in that pause.

import (
	"math/rand"
	"regexp"
	"strings"
	"unicode"
)

type Boundary int

const (
	BNone Boundary = iota
	BClause
	BSentence
	BPara
	BEllipsis
)

func (b Boundary) String() string {
	return [...]string{"none", "clause", "sentence", "para", "ellipsis"}[b]
}

type Segment struct {
	Index         int      `json:"index"`
	Text          string   `json:"text"`
	Units         float64  `json:"units"`
	PauseBeforeMs int      `json:"pause_ms"`
	Breath        bool     `json:"breath"`
	Boundary      Boundary `json:"-"`
	BoundaryName  string   `json:"boundary"`
}

type SegCfg struct {
	ImmediateFirst           bool    // Live chat: submit a complete first prefix without another delta.
	PreserveText             bool    // Application sessions preserve source instead of rewriting it.
	FirstMin, FirstMax       float64 // units
	Min, Target, Max         float64
	PauseClause, PauseSent   int
	PausePara, PauseEllipsis int
}

func DefaultSegCfg(p *ProfileInfo) SegCfg {
	c := SegCfg{FirstMin: 7, FirstMax: 20, Min: 12, Target: 26, Max: 64,
		PauseClause: 150, PauseSent: 340, PausePara: 560, PauseEllipsis: 460}
	if p != nil {
		if p.PauseClauseMs > 0 {
			c.PauseClause = clampInt(p.PauseClauseMs, 60, 400)
		}
		if p.PauseSentenceMs > 0 {
			c.PauseSent = clampInt(p.PauseSentenceMs, 160, 800)
		}
		if p.PauseParaMs > 0 {
			c.PausePara = clampInt(p.PauseParaMs, 260, 1200)
		}
		c.PauseEllipsis = clampInt(int(float64(c.PauseSent)*1.35), 260, 900)
	}
	return c
}

// ExactSegCfg preserves source contents; acoustic fidelity is NOT verified here.
func ExactSegCfg(p *ProfileInfo) SegCfg {
	c := DefaultSegCfg(p)
	c.PreserveText = true
	return c
}

// ReadSegCfg groups more complete clauses to reduce independent prosody resets.
// Does not modify text or promise identical speaker acoustics across generations.
func ReadSegCfg(p *ProfileInfo) SegCfg {
	c := ExactSegCfg(p)
	c.FirstMin = 12
	c.FirstMax = 24
	c.Min = 20
	c.Target = 40
	c.Max = 80
	return c
}

// LiveSegCfg changes only live-chat first-prefix scheduling. Read mode stays exact/stable.
func LiveSegCfg(p *ProfileInfo) SegCfg {
	c := ExactSegCfg(p)
	c.ImmediateFirst = true
	return c
}

// Avoid sending an opening quote/bracket without its closing delimiter.
func openFirstDelimiter(buf []rune) bool {
	stack := []rune{}
	pairs := map[rune]rune{'“': '”', '「': '」', '『': '』', '（': '）', '(': ')', '【': '】', '《': '》'}
	quoted := false
	for _, r := range buf {
		if r == '"' {
			quoted = !quoted
			continue
		}
		if end, ok := pairs[r]; ok {
			stack = append(stack, end)
		} else if len(stack) > 0 && r == stack[len(stack)-1] {
			stack = stack[:len(stack)-1]
		}
	}
	return quoted || len(stack) > 0
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

type Segmenter struct {
	cfg        SegCfg
	buf        []rune
	idx        int
	lastB      Boundary
	sinceBreth float64
	rng        *rand.Rand
}

func NewSegmenter(cfg SegCfg, seed int64) *Segmenter {
	return &Segmenter{cfg: cfg, rng: rand.New(rand.NewSource(seed))}
}

var (
	reURL     = regexp.MustCompile(`https?://\S+`)
	reMdChars = regexp.MustCompile("[*#`_>|~]+")
	reSpaces  = regexp.MustCompile(`[ \t\x{3000}]+`)
)

func isEmoji(r rune) bool {
	return (r >= 0x1F000 && r <= 0x1FAFF) || (r >= 0x2600 && r <= 0x27BF) || r == 0xFE0F || r == 0x200D
}

// CleanDelta strips markdown/emoji noise that a TTS model would try to pronounce.
func CleanDelta(s string) string {
	s = reURL.ReplaceAllString(s, "")
	s = reMdChars.ReplaceAllString(s, "")
	var b strings.Builder
	for _, r := range s {
		if isEmoji(r) {
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

func isCJK(r rune) bool {
	return unicode.Is(unicode.Han, r) || unicode.Is(unicode.Hiragana, r) || unicode.Is(unicode.Katakana, r) || unicode.Is(unicode.Hangul, r)
}

func isWordRune(r rune) bool { return unicode.IsLetter(r) || unicode.IsDigit(r) || r == '\'' }

// Units: CJK char = 1, latin word = 1.6 (rough spoken length).
func Units(s string) float64 {
	u := 0.0
	in := false
	for _, r := range s {
		if isCJK(r) {
			u++
			in = false
		} else if isWordRune(r) {
			if !in {
				u += 1.6
			}
			in = true
		} else {
			in = false
		}
	}
	return u
}

const (
	kNone = iota
	kClause
	kSentence
	kPara
)

func isClosers(r rune) bool {
	switch r {
	case '"', '\'', '”', '’', '」', '』', '）', ')', '】', ']', '》', '>':
		return true
	}
	return false
}

func isPunct(r rune) bool {
	switch r {
	case '。', '！', '？', '!', '?', '…', '；', ';', '，', ',', '、', '：', ':', '—', '.':
		return true
	}
	return false
}

func classify(buf []rune, i int, final bool) int {
	r := buf[i]
	switch r {
	case '。', '！', '？', '!', '?', '…':
		return kSentence
	case '\n':
		return kPara
	case '；', ';', '，', ',', '、', '：', ':', '—':
		return kClause
	case '.':
		// sentence end only if followed by space/newline/CJK or at the final end
		if i+1 < len(buf) {
			n := buf[i+1]
			if i > 0 && unicode.IsDigit(buf[i-1]) && unicode.IsDigit(n) {
				return kNone
			}
			if unicode.IsSpace(n) || isCJK(n) || n == '.' || isClosers(n) {
				return kSentence
			}
			return kNone
		}
		if final {
			return kSentence
		}
		return kSentence // lookahead is enforced by the caller
	}
	return kNone
}

func (s *Segmenter) limits() (min, target, max float64) {
	if s.idx == 0 {
		return s.cfg.FirstMin, s.cfg.FirstMin, s.cfg.FirstMax
	}
	return s.cfg.Min, s.cfg.Target, s.cfg.Max
}

// cut finds the end index (exclusive) of the next segment in buf.
func (s *Segmenter) cut(final bool) (end int, b Boundary, ok bool) {
	min, target, max := s.limits()
	buf := s.buf
	units := 0.0
	in := false
	lastClause, lastClauseUnits := -1, 0.0
	for i := 0; i < len(buf); i++ {
		r := buf[i]
		if isCJK(r) {
			units++
			in = false
		} else if isWordRune(r) {
			if !in {
				units += 1.6
			}
			in = true
		} else {
			in = false
		}
		k := classify(buf, i, final)
		if k == kNone {
			if units >= max {
				if lastClause >= 0 && lastClauseUnits >= min {
					return lastClause, BClause, true
				}
				if unicode.IsSpace(r) || isCJK(r) {
					return i + 1, BNone, true
				}
			}
			continue
		}
		// swallow repeated punctuation / closing quotes / trailing spaces
		j := i + 1
		ell := r == '…'
		dots := 0
		if r == '.' {
			dots = 1
		}
		for j < len(buf) && (isPunct(buf[j]) || isClosers(buf[j]) || (buf[j] == '\n' && k == kPara)) {
			if buf[j] == '…' {
				ell = true
			}
			if buf[j] == '.' {
				dots++
			}
			j++
		}
		if dots >= 3 {
			ell = true
		}
		if j >= len(buf) && !final {
			if s.cfg.ImmediateFirst && s.idx == 0 && r != '.' && !openFirstDelimiter(buf[:j]) {
				if (k == kSentence || k == kPara) && units >= 1 {
					bd := BSentence
					if k == kPara {
						bd = BPara
					} else if ell {
						bd = BEllipsis
					}
					return j, bd, true
				}
				if k == kClause && units >= min {
					return j, BClause, true
				}
			}
			return 0, BNone, false // ASCII decimal / unknown delimiter still needs lookahead.
		}
		for j < len(buf) && (buf[j] == ' ' || buf[j] == '\t') {
			j++
		}
		if j >= len(buf) && !final {
			if s.cfg.ImmediateFirst && s.idx == 0 && r != '.' && !openFirstDelimiter(buf[:j]) {
				if (k == kSentence || k == kPara) && units >= 1 {
					bd := BSentence
					if k == kPara {
						bd = BPara
					} else if ell {
						bd = BEllipsis
					}
					return j, bd, true
				}
				if k == kClause && units >= min {
					return j, BClause, true
				}
			}
			return 0, BNone, false // ASCII decimal / unknown delimiter still needs lookahead.
		}
		kk := k
		if kk == kSentence && j > 0 && buf[j-1] == '\n' {
			kk = kPara
		}
		switch kk {
		case kSentence, kPara:
			bd := BSentence
			if kk == kPara {
				bd = BPara
			} else if ell {
				bd = BEllipsis
			}
			if units >= min || (s.cfg.ImmediateFirst && s.idx == 0 && units >= 1) || (kk == kPara && units >= 3) || (final && j >= len(buf)) {
				return j, bd, true
			}
			lastClause, lastClauseUnits = j, units
		case kClause:
			if units >= target {
				return j, BClause, true
			}
			lastClause, lastClauseUnits = j, units
		}
		i = j - 1
	}
	return 0, BNone, false
}

func (s *Segmenter) pauseFor(b Boundary) int {
	var base int
	switch b {
	case BClause:
		base = s.cfg.PauseClause
	case BSentence:
		base = s.cfg.PauseSent
	case BPara:
		base = s.cfg.PausePara
	case BEllipsis:
		base = s.cfg.PauseEllipsis
	default:
		return 60
	}
	// +-12% human-like irregularity
	return int(float64(base) * (0.88 + 0.24*s.rng.Float64()))
}

func (s *Segmenter) finish(raw []rune, b Boundary) (Segment, bool) {
	txt := string(raw)
	if !s.cfg.PreserveText {
		txt = strings.TrimSpace(txt)
		txt = reSpaces.ReplaceAllString(txt, " ")
	}
	hasWord := false
	for _, r := range txt {
		if isWordRune(r) || isCJK(r) {
			hasWord = true
			break
		}
	}
	if !hasWord {
		// carry the boundary strength to the next segment
		if b > s.lastB {
			s.lastB = b
		}
		return Segment{}, false
	}
	// make sure the model gets a clean ending (avoids runaway generation / clipped finals)
	last, _ := lastRune(txt)
	if !s.cfg.PreserveText && !isPunct(last) && !isClosers(last) {
		if containsCJK(txt) {
			txt += "。"
		} else {
			txt += "."
		}
	}
	u := Units(txt)
	seg := Segment{Index: s.idx, Text: txt, Units: u}
	if s.idx > 0 {
		seg.PauseBeforeMs = s.pauseFor(s.lastB)
		seg.Boundary = s.lastB
		seg.BoundaryName = s.lastB.String()
		// breath policy: humans breathe at phrase ends, not at every comma
		switch s.lastB {
		case BPara:
			seg.Breath = true
		case BSentence, BEllipsis:
			seg.Breath = s.sinceBreth >= 16 || s.rng.Float64() < 0.35
		case BClause:
			seg.Breath = s.sinceBreth >= 34 && seg.PauseBeforeMs >= 200
			if seg.Breath {
				seg.PauseBeforeMs = clampInt(seg.PauseBeforeMs+120, 200, 600)
			}
		}
		if seg.Breath && seg.PauseBeforeMs < 280 {
			seg.PauseBeforeMs = 280
		}
	}
	if seg.Breath {
		s.sinceBreth = 0
	}
	s.sinceBreth += u
	s.lastB = b
	s.idx++
	return seg, true
}

func lastRune(s string) (rune, bool) {
	rs := []rune(s)
	if len(rs) == 0 {
		return 0, false
	}
	return rs[len(rs)-1], true
}

func containsCJK(s string) bool {
	for _, r := range s {
		if isCJK(r) {
			return true
		}
	}
	return false
}

func (s *Segmenter) drain(final bool) []Segment {
	var out []Segment
	for {
		if len(s.buf) == 0 {
			return out
		}
		end, b, ok := s.cut(final)
		if !ok {
			if final {
				if seg, ok2 := s.finish(s.buf, BNone); ok2 {
					out = append(out, seg)
				}
				s.buf = nil
			}
			return out
		}
		raw := append([]rune(nil), s.buf[:end]...)
		s.buf = s.buf[end:]
		if seg, ok2 := s.finish(raw, b); ok2 {
			out = append(out, seg)
		}
	}
}

// Feed adds an LLM delta and returns any segments that are now complete.
func (s *Segmenter) Feed(delta string) []Segment {
	if !s.cfg.PreserveText {
		delta = CleanDelta(delta)
	}
	s.buf = append(s.buf, []rune(delta)...)
	return s.drain(false)
}

// Flush returns whatever is left at the end of the stream.
func (s *Segmenter) Flush() []Segment { return s.drain(true) }
