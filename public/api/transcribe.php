<?php
declare(strict_types=1);

ini_set('display_errors', '0');
ini_set('log_errors', '1');
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

/** Per-request cap: the client splits longer audio into chunks of this size. */
const DEFAULT_MAX_AUDIO_SECONDS_PER_REQUEST = 120;
/** Quota defaults, counted in AUDIO SECONDS. Keep in sync with src/config/limits.ts. */
const DEFAULT_AUDIO_SECONDS_PER_HOUR = 1800;
const DEFAULT_AUDIO_SECONDS_PER_DAY = 5400;
const DEFAULT_GLOBAL_AUDIO_SECONDS_PER_HOUR = 7200;
const DEFAULT_GLOBAL_AUDIO_SECONDS_PER_DAY = 28800;

function respond(int $status, string $message, int $retryAfterSeconds = 0, array $extra = []): never
{
    http_response_code($status);
    $payload = ['error' => $message] + $extra;
    if ($retryAfterSeconds > 0) {
        $payload['retryAfterSeconds'] = $retryAfterSeconds;
        header('Retry-After: ' . $retryAfterSeconds);
    }
    echo json_encode($payload, JSON_UNESCAPED_SLASHES);
    exit;
}

function serverLog(string $message): void
{
    error_log('[SubtitleStudio] ' . $message);
}

function normalisedHost(string $value): ?array
{
    $parts = parse_url($value);
    if (!is_array($parts) || empty($parts['host'])) {
        return null;
    }

    return [
        'host' => strtolower(rtrim($parts['host'], '.')),
        'port' => isset($parts['port']) ? (int) $parts['port'] : null,
        'scheme' => isset($parts['scheme']) ? strtolower($parts['scheme']) : null,
    ];
}

function requestIsAllowed(array $config): bool
{
    $allowedHosts = $config['allowed_hosts'] ?? null;
    $requestHost = normalisedHost('https://' . ($_SERVER['HTTP_HOST'] ?? ''));
    if (!is_array($allowedHosts) || !$requestHost) {
        return false;
    }
    $allowedHosts = array_map(
        static fn ($host): string => is_string($host) ? strtolower(rtrim(trim($host), '.')) : '',
        $allowedHosts
    );
    if (!in_array($requestHost['host'], $allowedHosts, true)) {
        return false;
    }

    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    $referer = $_SERVER['HTTP_REFERER'] ?? '';
    if ($origin === '' && $referer === '') {
        return false;
    }

    foreach ([$origin, $referer] as $source) {
        if ($source === '') {
            continue;
        }
        $parsed = normalisedHost($source);
        if (!$parsed || $parsed['scheme'] !== 'https' || $parsed['host'] !== $requestHost['host']) {
            return false;
        }
        $sourcePort = $parsed['port'] ?? 443;
        $requestPort = $requestHost['port'] ?? 443;
        if ($sourcePort !== $requestPort) {
            return false;
        }
    }

    return true;
}

/** Positive integer from config, or the documented fallback. */
function configuredLimit(array $config, string $key, int $fallback): int
{
    $value = $config[$key] ?? null;
    return is_int($value) && $value > 0 ? $value : $fallback;
}

/**
 * Read the WAV duration and format from the file's own header. The duration is
 * always computed on the server; a client claim is never trusted.
 *
 * @return array{duration: float, sampleRate: int, channels: int, bits: int}|null
 */
function readWavInfo(string $path): ?array
{
    $handle = @fopen($path, 'rb');
    if ($handle === false) {
        return null;
    }
    $head = fread($handle, 65536);
    fclose($handle);
    if (!is_string($head) || strlen($head) < 44) {
        return null;
    }
    if (substr($head, 0, 4) !== 'RIFF' || substr($head, 8, 4) !== 'WAVE') {
        return null;
    }

    $length = strlen($head);
    $offset = 12;
    $sampleRate = 0;
    $channels = 0;
    $bits = 0;
    $audioFormat = 0;
    $dataSize = -1;
    while ($offset + 8 <= $length) {
        $chunkId = substr($head, $offset, 4);
        $chunkSize = unpack('V', substr($head, $offset + 4, 4))[1];
        $chunkStart = $offset + 8;
        if ($chunkId === 'fmt ') {
            if ($chunkStart + 16 > $length) {
                return null;
            }
            $audioFormat = unpack('v', substr($head, $chunkStart, 2))[1];
            $channels = unpack('v', substr($head, $chunkStart + 2, 2))[1];
            $sampleRate = unpack('V', substr($head, $chunkStart + 4, 4))[1];
            $bits = unpack('v', substr($head, $chunkStart + 14, 2))[1];
        } elseif ($chunkId === 'data') {
            $dataSize = $chunkSize;
            break;
        }
        $offset = $chunkStart + $chunkSize + ($chunkSize % 2);
    }

    if ($audioFormat !== 1 || $channels < 1 || $channels > 2 || $sampleRate < 8000 || $sampleRate > 48000 || $bits !== 16 || $dataSize < 0) {
        return null;
    }
    $bytesPerSecond = $sampleRate * $channels * ($bits / 8);
    if ($bytesPerSecond <= 0) {
        return null;
    }
    return [
        'duration' => $dataSize / $bytesPerSecond,
        'sampleRate' => $sampleRate,
        'channels' => $channels,
        'bits' => $bits,
    ];
}

/**
 * Best-effort client IP. Behind a CDN/proxy every request can arrive with the
 * same REMOTE_ADDR, so prefer Cloudflare's header, then the first public IP in
 * X-Forwarded-For, and only fall back to REMOTE_ADDR.
 */
function clientIpAddress(): string
{
    $cloudflare = $_SERVER['HTTP_CF_CONNECTING_IP'] ?? '';
    if (is_string($cloudflare) && trim($cloudflare) !== '') {
        return trim($cloudflare);
    }

    $forwarded = $_SERVER['HTTP_X_FORWARDED_FOR'] ?? '';
    if (is_string($forwarded) && trim($forwarded) !== '') {
        foreach (explode(',', $forwarded) as $part) {
            $ip = trim($part);
            if ($ip === '') {
                continue;
            }
            if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) !== false) {
                return $ip;
            }
        }
    }

    return $_SERVER['REMOTE_ADDR'] ?? 'unknown';
}

/**
 * Count the request against the audio-second quota. Returns the number of
 * seconds to wait when a limit is hit, or 0 when the request is allowed.
 */
function takeRateLimit(array $config, string $privateRoot, float $audioSeconds, bool $consume = true): int
{
    $hourLimit = configuredLimit($config, 'audio_seconds_per_hour', DEFAULT_AUDIO_SECONDS_PER_HOUR);
    $dayLimit = configuredLimit($config, 'audio_seconds_per_day', DEFAULT_AUDIO_SECONDS_PER_DAY);
    $globalHourLimit = configuredLimit($config, 'global_audio_seconds_per_hour', DEFAULT_GLOBAL_AUDIO_SECONDS_PER_HOUR);
    $globalDayLimit = configuredLimit($config, 'global_audio_seconds_per_day', DEFAULT_GLOBAL_AUDIO_SECONDS_PER_DAY);

    $outsideDirectory = $privateRoot . DIRECTORY_SEPARATOR . 'subtitle-studio-data';
    $insideDirectory = __DIR__ . DIRECTORY_SEPARATOR . '.data';
    $dataDirectory = $outsideDirectory;
    if ((!is_dir($dataDirectory) && !@mkdir($dataDirectory, 0700, true)) || !is_writable($dataDirectory)) {
        $dataDirectory = $insideDirectory;
        if ((!is_dir($dataDirectory) && !@mkdir($dataDirectory, 0700, true)) || !is_writable($dataDirectory)) {
            serverLog('No writable rate-limit data directory is available.');
            respond(500, 'The transcription service is temporarily unavailable.');
        }
    }

    $handle = @fopen($dataDirectory . DIRECTORY_SEPARATOR . 'rate-limit.json', 'c+');
    if ($handle === false || !flock($handle, LOCK_EX)) {
        if (is_resource($handle)) {
            fclose($handle);
        }
        serverLog('Could not lock the rate-limit data file.');
        respond(500, 'The transcription service is temporarily unavailable.');
    }

    $now = time();
    $stateContents = stream_get_contents($handle);
    $state = $stateContents === '' ? [] : json_decode($stateContents, true);
    if (!is_array($state)) {
        flock($handle, LOCK_UN);
        fclose($handle);
        serverLog('Rate-limit data is invalid JSON.');
        respond(500, 'The transcription service is temporarily unavailable.');
    }
    if (isset($state['ip_audio']) && !is_array($state['ip_audio'])) {
        flock($handle, LOCK_UN);
        fclose($handle);
        serverLog('Rate-limit data has an invalid client history.');
        respond(500, 'The transcription service is temporarily unavailable.');
    }

    $ipKey = hash('sha256', clientIpAddress());
    $ipHistory = $state['ip_audio'] ?? [];
    $prunedHistory = [];
    foreach ($ipHistory as $clientKey => $clientEntries) {
        if (!is_array($clientEntries)) {
            flock($handle, LOCK_UN);
            fclose($handle);
            serverLog('Rate-limit data has an invalid client record.');
            respond(500, 'The transcription service is temporarily unavailable.');
        }
        $recentEntries = array_values(array_filter(
            $clientEntries,
            static fn ($entry): bool => is_array($entry)
                && isset($entry['t'], $entry['s'])
                && is_int($entry['t'])
                && is_numeric($entry['s'])
                && $entry['t'] > $now - 86400
        ));
        if ($recentEntries !== []) {
            $prunedHistory[$clientKey] = $recentEntries;
        }
    }
    $clientEntries = $prunedHistory[$ipKey] ?? [];

    $hourSeconds = 0.0;
    $daySeconds = 0.0;
    $oldestHour = null;
    $oldestDay = null;
    foreach ($clientEntries as $entry) {
        $seconds = (float) $entry['s'];
        $daySeconds += $seconds;
        if ($oldestDay === null || $entry['t'] < $oldestDay) {
            $oldestDay = $entry['t'];
        }
        if ($entry['t'] > $now - 3600) {
            $hourSeconds += $seconds;
            if ($oldestHour === null || $entry['t'] < $oldestHour) {
                $oldestHour = $entry['t'];
            }
        }
    }

    $globalHourBuckets = $state['global_audio_hours'] ?? [];
    $globalDayBuckets = $state['global_audio_days'] ?? [];
    if (!is_array($globalHourBuckets) || !is_array($globalDayBuckets)) {
        flock($handle, LOCK_UN);
        fclose($handle);
        serverLog('Rate-limit data has invalid global history.');
        respond(500, 'The transcription service is temporarily unavailable.');
    }
    $hourKey = gmdate('Y-m-d H');
    $utcDay = gmdate('Y-m-d');
    $globalHourSeconds = is_numeric($globalHourBuckets[$hourKey] ?? null) ? (float) $globalHourBuckets[$hourKey] : 0.0;
    $globalDaySeconds = is_numeric($globalDayBuckets[$utcDay] ?? null) ? (float) $globalDayBuckets[$utcDay] : 0.0;

    $retryAfter = 0;
    if ($hourSeconds + $audioSeconds > $hourLimit && $oldestHour !== null) {
        $retryAfter = max($retryAfter, ($oldestHour + 3600) - $now);
    }
    if ($daySeconds + $audioSeconds > $dayLimit && $oldestDay !== null) {
        $retryAfter = max($retryAfter, ($oldestDay + 86400) - $now);
    }
    if ($globalHourSeconds + $audioSeconds > $globalHourLimit) {
        $retryAfter = max($retryAfter, 3600 - ($now % 3600));
    }
    if ($globalDaySeconds + $audioSeconds > $globalDayLimit) {
        $retryAfter = max($retryAfter, strtotime('tomorrow 00:00:00 UTC') - $now);
    }
    if ($retryAfter > 0) {
        flock($handle, LOCK_UN);
        fclose($handle);
        return max(1, (int) ceil((float) $retryAfter));
    }

    // When only checking (not yet consuming), release the lock without counting.
    // The quota is recorded later, only after the upstream call has succeeded.
    if (!$consume) {
        flock($handle, LOCK_UN);
        fclose($handle);
        return 0;
    }

    $clientEntries[] = ['t' => $now, 's' => round($audioSeconds, 2)];
    $prunedHistory[$ipKey] = $clientEntries;

    // Keep one hour of global hourly buckets and 31 days of daily buckets.
    $globalHourBuckets = array_filter($globalHourBuckets, static fn ($value, $key): bool => is_string($key) && $key >= gmdate('Y-m-d H', $now - 3600 * 2), ARRAY_FILTER_USE_BOTH);
    $globalDayBuckets = array_filter($globalDayBuckets, static fn ($value, $key): bool => is_string($key) && $key >= gmdate('Y-m-d', $now - 86400 * 31), ARRAY_FILTER_USE_BOTH);
    $globalHourBuckets[$hourKey] = round($globalHourSeconds + $audioSeconds, 2);
    $globalDayBuckets[$utcDay] = round($globalDaySeconds + $audioSeconds, 2);

    $state['ip_audio'] = $prunedHistory;
    $state['global_audio_hours'] = $globalHourBuckets;
    $state['global_audio_days'] = $globalDayBuckets;

    rewind($handle);
    $encodedState = json_encode($state);
    if ($encodedState === false || !ftruncate($handle, 0) || fwrite($handle, $encodedState) !== strlen($encodedState) || !fflush($handle)) {
        flock($handle, LOCK_UN);
        fclose($handle);
        serverLog('Could not persist rate-limit data.');
        respond(500, 'The transcription service is temporarily unavailable.');
    }

    flock($handle, LOCK_UN);
    fclose($handle);
    return 0;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: POST');
    respond(405, 'Method not allowed. Send a POST request.');
}

$contentLength = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
if ($contentLength > 12 * 1024 * 1024 || ($contentLength > 0 && empty($_POST) && empty($_FILES))) {
    respond(413, 'The upload is too large. Audio is sent in short chunks.');
}

$documentRoot = rtrim((string) ($_SERVER['DOCUMENT_ROOT'] ?? dirname(__DIR__)), DIRECTORY_SEPARATOR);
$privateRoot = dirname($documentRoot);
$privateConfigPath = $privateRoot . DIRECTORY_SEPARATOR . 'config.php';
$fallbackConfigPath = __DIR__ . DIRECTORY_SEPARATOR . 'config.php';
$configPath = is_file($privateConfigPath) ? $privateConfigPath : $fallbackConfigPath;
if (!is_file($configPath)) {
    serverLog('The private configuration file is missing.');
    respond(500, 'The transcription service is not configured yet.');
}

try {
    $config = require $configPath;
} catch (Throwable $error) {
    serverLog('The private configuration could not be loaded (' . get_class($error) . ').');
    respond(500, 'The transcription service is not configured correctly.');
}
if (!is_array($config) || !is_string($config['groq_api_key'] ?? null) || trim($config['groq_api_key']) === '' || $config['groq_api_key'] === 'YOUR_GROQ_API_KEY_HERE') {
    serverLog('The private configuration is invalid.');
    respond(500, 'The transcription service is not configured correctly.');
}

if (!requestIsAllowed($config)) {
    respond(403, 'This request did not come from an allowed site.');
}

if (isset($_POST['language'])) {
    $language = $_POST['language'];
    if (!is_string($language) || !in_array($language, ['auto', 'ur', 'hi', 'en', 'ar', 'fa', 'tr', 'es', 'fr', 'he'], true)) {
        respond(400, 'The selected language is not supported.');
    }
} else {
    $language = 'auto';
}

if (isset($_FILES['file']['error']) && in_array($_FILES['file']['error'], [UPLOAD_ERR_INI_SIZE, UPLOAD_ERR_FORM_SIZE], true)) {
    respond(413, 'The upload is too large. Audio is sent in short chunks.');
}
if (!isset($_FILES['file']) || !is_array($_FILES['file']) || ($_FILES['file']['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
    respond(400, 'Choose an audio file and try again.');
}

$uploadedFile = $_FILES['file'];
$temporaryPath = $uploadedFile['tmp_name'] ?? '';
$actualSize = is_string($temporaryPath) && is_uploaded_file($temporaryPath) ? filesize($temporaryPath) : false;
if (!is_int($actualSize) || $actualSize <= 44) {
    respond(400, 'The uploaded audio file is empty or invalid.');
}
if ($actualSize > 10 * 1024 * 1024) {
    respond(413, 'The upload is too large. Audio is sent in short chunks.');
}

if (!class_exists('finfo')) {
    serverLog('The Fileinfo extension is unavailable.');
    respond(500, 'The transcription service is temporarily unavailable.');
}
$mimeType = (new finfo(FILEINFO_MIME_TYPE))->file($temporaryPath);
$allowedWavMimes = ['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave', 'audio/x-pn-wav'];
if (!in_array($mimeType, $allowedWavMimes, true)) {
    respond(415, 'Only valid WAV audio is supported.');
}

// Duration comes from the WAV header on the server, never from the client.
$wavInfo = readWavInfo($temporaryPath);
if ($wavInfo === null) {
    respond(415, 'Only valid 16-bit PCM WAV audio is supported.');
}
$maxAudioSeconds = configuredLimit($config, 'max_audio_seconds_per_request', DEFAULT_MAX_AUDIO_SECONDS_PER_REQUEST);
if ($wavInfo['duration'] > $maxAudioSeconds + 1) {
    respond(413, sprintf('Each audio chunk must be %d seconds or shorter. Split the audio and try again.', $maxAudioSeconds));
}

$retryAfter = takeRateLimit($config, $privateRoot, $wavInfo['duration'], false);
if ($retryAfter > 0) {
    $minutes = (int) ceil($retryAfter / 60);
    respond(429, sprintf('The transcription limit has been reached. Try again in about %d minute%s.', $minutes, $minutes === 1 ? '' : 's'), $retryAfter);
}

if (!function_exists('curl_init')) {
    serverLog('The cURL extension is unavailable.');
    respond(502, 'The transcription service is temporarily unavailable.');
}

// The provider call can take a while; make sure PHP does not cut it short.
@set_time_limit(220);

$curl = curl_init('https://api.groq.com/openai/v1/audio/transcriptions');
if ($curl === false) {
    serverLog('Could not initialise the upstream request.');
    respond(502, 'The transcription service is temporarily unavailable.');
}

$fields = [
    'file' => new CURLFile($temporaryPath, 'audio/wav', 'audio.wav'),
    'model' => 'whisper-large-v3-turbo',
    'response_format' => 'verbose_json',
    'timestamp_granularities[]' => 'word',
];
if ($language !== 'auto') {
    $fields['language'] = $language;
}

curl_setopt_array($curl, [
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => $fields,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_CONNECTTIMEOUT => 15,
    CURLOPT_TIMEOUT => 180,
    CURLOPT_SSL_VERIFYPEER => true,
    CURLOPT_SSL_VERIFYHOST => 2,
    CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . $config['groq_api_key']],
]);

$upstreamBody = curl_exec($curl);
$curlError = curl_error($curl);
$upstreamStatus = (int) curl_getinfo($curl, CURLINFO_HTTP_CODE);
curl_close($curl);
if ($upstreamBody === false) {
    serverLog('The upstream request failed: ' . $curlError);
    respond(502, 'Could not reach the transcription service. Please try again later.');
}
if ($upstreamStatus !== 200) {
    serverLog('The transcription provider returned HTTP ' . $upstreamStatus . '.');
    if ($upstreamStatus === 401 || $upstreamStatus === 403) {
        respond(502, 'The transcription service is not configured correctly. Please contact the site owner.');
    }
    if ($upstreamStatus === 429) {
        respond(429, 'The transcription provider is busy or its free-use limit has been reached. Please try again later.', 60, ['providerRateLimited' => true]);
    }
    if ($upstreamStatus >= 500) {
        respond(502, 'The transcription provider is temporarily unavailable. Please try again later.');
    }
    respond(502, 'The transcription provider could not process this audio.');
}

$result = json_decode($upstreamBody, true);
if (!is_array($result) || !isset($result['words']) || !is_array($result['words'])) {
    serverLog('The transcription provider returned an unexpected response.');
    respond(502, 'The transcription provider returned an invalid response. Please try again later.');
}

// Only count the audio seconds now that the upstream call succeeded, so failed
// provider calls never eat into the user's quota.
takeRateLimit($config, $privateRoot, $wavInfo['duration'], true);

http_response_code(200);
echo json_encode($result, JSON_UNESCAPED_SLASHES);
