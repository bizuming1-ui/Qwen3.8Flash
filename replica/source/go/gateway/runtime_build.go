package main
// Self-reported source ID; NOT environment attestation.
const runtimeSourceID = "55b46c32b7b0e85b93c0938890b5b140771155b614b04a8097bfc67be917d887"
func diagnosticMode(mode string) string { if mode == "read" { return "read" }; return "chat" }
func diagnosticContentSource(mode string) string { if mode=="read" { return "user_text" }; if mode=="chat" { return "llm_output" }; return "" }
