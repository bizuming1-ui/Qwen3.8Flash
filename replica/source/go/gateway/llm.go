package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

const defaultSystemPrompt = `你是一个诚实、友善的语音对话助手。
说话要求：
1. 用自然、口语化的语言回答，使用用户所用的语言。
2. 不要使用任何markdown、列表、编号、表情符号、括号注释、代码或链接。
3. 句子要短，一句话尽量不超过25个字，用逗号和句号制造自然的停顿和换气点。
4. 数字、单位用口语读法写出来。
5. 先直接回答，再根据用户需要充分展开；用户要求详细说明时可以输出长文本，不预设200字上限。
6. 语气有温度，可以有轻微的语气词，但不要夸张。`

type ChatMsg struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

var llmClient = &http.Client{
	Transport: &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           (&net.Dialer{Timeout: 8 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          8,
		MaxIdleConnsPerHost:   4,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   8 * time.Second,
		ResponseHeaderTimeout: 25 * time.Second,
	},
}

// PreconnectLLM opens (and parks) a TLS connection so the first real request skips the handshake.
func PreconnectLLM(base string) {
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(base, "/")+"/models", nil)
	if err != nil {
		return
	}
	resp, err := llmClient.Do(req)
	if err == nil {
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
	}
}

// StreamLLM calls an OpenAI-compatible streaming chat endpoint (DeepSeek) and invokes onDelta
// for every content delta as soon as it arrives.
func StreamLLM(ctx context.Context, cfg *Config, key string, msgs []ChatMsg, onDelta func(string)) error {
	if key == "" {
		return errors.New("DEEPSEEK_API_KEY is not set (set it in Kaggle secrets / env, or paste it in the UI)")
	}
	body, _ := json.Marshal(map[string]any{
		"model":       cfg.LLMModel,
		"messages":    msgs,
		"stream":      true,
		"temperature": 0.7,
		"max_tokens":  cfg.LLMMaxTokens,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(cfg.LLMBase, "/")+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Accept", "text/event-stream")
	resp, err := llmClient.Do(req)
	if err != nil {
		return fmt.Errorf("llm request: %w", err)
	}
	defer resp.Body.Close()
	diagnosticLLMMark(ctx, "llm_response_headers")
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 800))
		return fmt.Errorf("llm http %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}
	rd := bufio.NewReaderSize(resp.Body, 16*1024)
	finished := false
	for {
		line, err := rd.ReadString('\n')
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "data:") {
			data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
			if data == "[DONE]" {
				return nil
			}
			var ch struct {
				Choices []struct {
					Delta struct {
						Content string `json:"content"`
					} `json:"delta"`
					FinishReason *string `json:"finish_reason"`
				} `json:"choices"`
				Error *struct {
					Message string `json:"message"`
				} `json:"error"`
			}
			if err := json.Unmarshal([]byte(data), &ch); err != nil {
				return fmt.Errorf("invalid LLM stream JSON")
			}
			if ch.Error != nil {
				return fmt.Errorf("LLM stream reported an error")
			}
			for _, choice := range ch.Choices {
				if c := choice.Delta.Content; c != "" {
					onDelta(c)
				}
				if choice.FinishReason != nil {
					if *choice.FinishReason != "stop" {
						return fmt.Errorf("LLM output incomplete (finish_reason=%s)", *choice.FinishReason)
					}
					finished = true
				}
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				if finished {
					return nil
				}
				return fmt.Errorf("LLM stream ended before completion")
			}
			return err
		}
	}
}
