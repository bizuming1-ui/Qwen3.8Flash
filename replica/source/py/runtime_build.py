"""Self-reported source fingerprint, NOT hardware/quality attestation."""
SOURCE_BUILD_ID = '55b46c32b7b0e85b93c0938890b5b140771155b614b04a8097bfc67be917d887'
def content_source(mode):
    return 'user_text' if mode == 'read' else 'llm_output' if mode == 'chat' else None
