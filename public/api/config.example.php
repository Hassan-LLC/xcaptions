<?php
return [
    'groq_api_key' => 'YOUR_GROQ_API_KEY_HERE',
    'allowed_hosts' => ['your-domain.example'],

    // Transcription quota, counted in AUDIO SECONDS (not requests), per IP.
    'audio_seconds_per_hour' => 1800,
    'audio_seconds_per_day' => 5400,

    // Whole-account caps in audio seconds. The Groq free tier allows roughly
    // 7,200 audio seconds per hour and 28,800 per day, so these ceiling values
    // protect the shared key from being exhausted by one busy hour.
    'global_audio_seconds_per_hour' => 7200,
    'global_audio_seconds_per_day' => 28800,

    // Largest audio chunk the client may send in one request, in seconds.
    // Keep this in sync with MAX_AUDIO_CHUNK_SECONDS in src/config/limits.ts.
    'max_audio_seconds_per_request' => 120,

    // Translation limits are still counted per request (batches of 40 captions).
    'TRANSLATE_MODEL' => 'qwen/qwen3.8-27b',
    'translate_requests_per_hour' => 60,
    'translate_requests_per_day' => 300,
    'translate_global_daily_cap' => 1000,
];
