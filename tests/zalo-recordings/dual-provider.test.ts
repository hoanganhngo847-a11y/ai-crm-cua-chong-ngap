/**
 * Dual Transcription Provider & Worker Integration Tests
 *
 * Verifies:
 * 1. Factory defaults & strict fail-closed validation (no fallback, no raw input in errors).
 * 2. OpenAI provider contract with mocked fetch (model whisper-1, verbose_json segments, error mappings).
 * 3. Sanitizer defenses (redacting Google API keys, headers, bearer tokens, paths).
 * 4. PGlite true PostgreSQL integration:
 *    - Full success with GEMINI provider: verifies provider & model persisted in DB.
 *    - Left=CUSTOMER, Right=STAFF chronological utterance merge in utterances table.
 *    - Failure metadata persisted before upload under ownership fencing.
 *    - Permanent vs transient retry semantics.
 *    - No fallback from Gemini to OpenAI.
 *    - Fencing against lock loss, expired lease, null lease, cross-tenant mutation.
 *    - ACL security: actual SET ROLE execution checks (anon & authenticated denied), authenticated SELECT for model.
 *    - Original audio immutability.
 *    - Worker metadata RPC fault injection (error, false, null outcomes prevent all provider calls).
 *    - Safe model/provider validation & credential leak defenses.
 *    - Job deadline boundary conditions (deadline 0 treated as past limit).
 * 5. Environment isolation: tests independent from real host OPENAI/GEMINI environment variables.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sha256 } from "../../features/zalo-recordings/metadata";
import { uploadRecording, RECORDING_BUCKET } from "../../features/zalo-recordings/upload";
import { OpenAITranscriptionProvider, MockTranscriptionProvider } from "../../features/zalo-transcription/provider";
import {
  createTranscriptionProvider,
  resolveProviderType,
  validateProviderType,
} from "../../features/zalo-transcription/provider-factory";
import {
  isPermanentError,
  processZaloTranscriptionJob,
  sanitizeErrorCode,
  sanitizeErrorMessage,
  validateSafeIdentifier,
  validateSafeModelIdentifier,
} from "../../features/zalo-transcription/service";
import type { ClaimedTranscriptionJob } from "../../features/zalo-transcription/types";
import { createPgliteSupabase } from "../zalo/helpers/pglite-supabase";
import { audioFixture, metadataFixture, uploadRequest } from "./fixture";

// ===========================================================================
// Environment Isolation Helpers (Requirement 6)
// ===========================================================================
const ISOLATED_ENV_VARS = [
  "TRANSCRIPTION_PROVIDER",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "OPENAI_TRANSCRIPTION_MODEL",
  "GEMINI_TRANSCRIPTION_MODEL",
] as const;

const initialEnvState: Record<string, string | undefined> = {};
for (const k of ISOLATED_ENV_VARS) {
  initialEnvState[k] = process.env[k];
}

function isolateCleanEnv(): void {
  for (const k of ISOLATED_ENV_VARS) {
    delete process.env[k];
  }
}

function restoreInitialEnv(): void {
  for (const k of ISOLATED_ENV_VARS) {
    if (initialEnvState[k] !== undefined) {
      process.env[k] = initialEnvState[k];
    } else {
      delete process.env[k];
    }
  }
}

// ===========================================================================
// Test Execution & Failure Tracking Harness
// ===========================================================================
interface TestFailure {
  name: string;
  error: Error;
  expectedFix: string;
}

const failures: TestFailure[] = [];

async function testCase(
  name: string,
  fn: () => Promise<void> | void,
  expectedFix?: string
): Promise<void> {
  console.log(`\n--- Test: ${name} ---`);
  try {
    await fn();
    console.log(`[PASS] ${name}`);
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(`[FAIL] ${name}`);
    console.error(`  Error: ${error.message}`);
    failures.push({
      name,
      error,
      expectedFix: expectedFix || "See assertion failure details.",
    });
  }
}

async function run() {
  console.log("=== Starting Dual Provider & PGlite Worker Integration Tests ===");

  try {
    // =========================================================================
    // Section 1: Provider Factory Selection & Fail-Closed Behavior
    // =========================================================================
    await testCase("Section 1: Provider Factory Selection & Fail-Closed Behavior", () => {
      isolateCleanEnv();
      try {
        // 1. Undefined defaults to OPENAI
        delete process.env.TRANSCRIPTION_PROVIDER;
        assert.equal(resolveProviderType(), "OPENAI", "Undefined must default to OPENAI");

        // 2. Explicit valid selectors
        process.env.TRANSCRIPTION_PROVIDER = "OPENAI";
        assert.equal(resolveProviderType(), "OPENAI");
        process.env.TRANSCRIPTION_PROVIDER = "openai";
        assert.equal(resolveProviderType(), "OPENAI");

        process.env.TRANSCRIPTION_PROVIDER = "GEMINI";
        assert.equal(resolveProviderType(), "GEMINI");
        process.env.TRANSCRIPTION_PROVIDER = "gemini";
        assert.equal(resolveProviderType(), "GEMINI");

        // 3. Blank or whitespace explicit selector fails closed
        process.env.TRANSCRIPTION_PROVIDER = "";
        assert.throws(
          () => resolveProviderType(),
          (err: Error) => err.message === "INVALID_TRANSCRIPTION_PROVIDER",
          "Empty string must fail closed with sanitized error code"
        );

        process.env.TRANSCRIPTION_PROVIDER = "   ";
        assert.throws(
          () => resolveProviderType(),
          (err: Error) => err.message === "INVALID_TRANSCRIPTION_PROVIDER",
          "Whitespace string must fail closed"
        );

        // 4. Invalid selector fails closed without raw input in error
        process.env.TRANSCRIPTION_PROVIDER = "claude-secret-leak";
        assert.throws(
          () => resolveProviderType(),
          (err: Error) => {
            return (
              err.message === "INVALID_TRANSCRIPTION_PROVIDER" &&
              !err.message.includes("claude-secret-leak")
            );
          },
          "Invalid provider must not reflect raw input in error message"
        );

        // 5. validateProviderType
        assert.equal(validateProviderType("OPENAI"), "OPENAI");
        assert.equal(validateProviderType("GEMINI"), "GEMINI");
        assert.throws(() => validateProviderType("unknown"), /INVALID_TRANSCRIPTION_PROVIDER/);

        // 6. createTranscriptionProvider factory returns correct instance under isolated clean env
        delete process.env.TRANSCRIPTION_PROVIDER;
        const defaultProvider = createTranscriptionProvider();
        assert.equal(defaultProvider.name, "OPENAI");
        assert.equal(defaultProvider.model, "whisper-1");

        const geminiProvider = createTranscriptionProvider("GEMINI");
        assert.equal(geminiProvider.name, "GEMINI");
        assert.equal(geminiProvider.model, "gemini-3.5-transcribe");
      } finally {
        isolateCleanEnv();
      }
    });

    // =========================================================================
    // Section 2: OpenAI Provider Contract & Mocked Fetch Verification
    // =========================================================================
    await testCase("Section 2: OpenAI Provider Contract & Fetch Mock", async () => {
      isolateCleanEnv();
      const oaiProvider = new OpenAITranscriptionProvider({
        apiKey: "test-openai-key-sk-1234567890",
      });
      assert.equal(oaiProvider.name, "OPENAI");
      assert.equal(oaiProvider.model, "whisper-1", "Default OpenAI model must be whisper-1");

      const originalFetch = globalThis.fetch;
      let interceptedUrl = "";
      let interceptedMethod = "";
      let interceptedAuth = "";
      let interceptedModel = "";
      let interceptedFormat = "";
      let interceptedFileName = "";

      try {
        globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          interceptedUrl = String(input);
          interceptedMethod = init?.method || "GET";
          const headers = init?.headers as Record<string, string>;
          interceptedAuth = headers?.authorization || "";

          if (init?.body instanceof FormData) {
            interceptedModel = String(init.body.get("model"));
            interceptedFormat = String(init.body.get("response_format"));
            const file = init.body.get("file") as File;
            interceptedFileName = file?.name || "";
          }

          const mockVerboseJson = {
            text: "Xin chào quý khách",
            language: "vi",
            duration: 3.5,
            segments: [
              { id: 0, start: 0.0, end: 1.5, text: "Xin chào", avg_logprob: -0.1 },
              { id: 1, start: 1.5, end: 3.5, text: "quý khách", avg_logprob: -0.05 },
            ],
          };

          return new Response(JSON.stringify(mockVerboseJson), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        };

        const testAudio = Buffer.from("dummy-mono-audio-content");
        const result = await oaiProvider.transcribe(testAudio, "customer_left.m4a", "audio/m4a", {
          language: "vi",
        });

        assert.equal(interceptedUrl, "https://api.openai.com/v1/audio/transcriptions");
        assert.equal(interceptedMethod, "POST");
        assert.equal(interceptedAuth, "Bearer test-openai-key-sk-1234567890");
        assert.equal(interceptedModel, "whisper-1", "Default model sent to OpenAI must be whisper-1");
        assert.equal(interceptedFormat, "verbose_json", "verbose_json response format required for segments");
        assert.equal(interceptedFileName, "customer_left.m4a");

        assert.equal(result.text, "Xin chào quý khách");
        assert.equal(result.language, "vi");
        assert.equal(result.duration_ms, 3500);
        assert.equal(result.segments.length, 2);
        assert.equal(result.segments[0].start_ms, 0);
        assert.equal(result.segments[0].end_ms, 1500);
        assert.equal(result.segments[0].text, "Xin chào");
        assert.equal(result.segments[1].start_ms, 1500);
        assert.equal(result.segments[1].end_ms, 3500);
        assert.equal(result.segments[1].text, "quý khách");

        // Verify error mappings with mocked error responses
        // 401 Auth Error
        globalThis.fetch = async () => new Response("Unauthorized", { status: 401 });
        await assert.rejects(
          () => oaiProvider.transcribe(testAudio, "test.m4a", "audio/m4a"),
          /TRANSCRIPTION_PROVIDER_AUTH_ERROR/
        );

        // 429 Rate limit
        globalThis.fetch = async () => new Response("Too Many Requests", { status: 429 });
        await assert.rejects(
          () => oaiProvider.transcribe(testAudio, "test.m4a", "audio/m4a"),
          /TRANSCRIPTION_RATE_LIMITED/
        );

        // 500 Provider unavailable
        globalThis.fetch = async () => new Response("Internal Server Error", { status: 500 });
        await assert.rejects(
          () => oaiProvider.transcribe(testAudio, "test.m4a", "audio/m4a"),
          /TRANSCRIPTION_PROVIDER_UNAVAILABLE/
        );

        // Unconfigured (no API key in options, isolated from process.env.OPENAI_API_KEY)
        const unconfigured = new OpenAITranscriptionProvider({ apiKey: "" });
        await assert.rejects(
          () => unconfigured.transcribe(testAudio, "test.m4a", "audio/m4a"),
          /TRANSCRIPTION_NOT_CONFIGURED/
        );
      } finally {
        globalThis.fetch = originalFetch;
        isolateCleanEnv();
      }
    });

    // =========================================================================
    // Section 3: Sanitization & Error Classification
    // =========================================================================
    await testCase("Section 3: Sanitizer & Error Classification", () => {
      // Google API key redaction
      const googleKeyMsg = "Google API call failed with key AIzaSyD-1234567890abcdef1234567890 in header";
      const sanitizedGoogle = sanitizeErrorMessage(new Error(googleKeyMsg));
      assert.ok(!sanitizedGoogle.includes("AIzaSyD-"), "Google API key must be redacted");
      assert.ok(sanitizedGoogle.includes("AIza***"), "Google API key replaced with AIza***");

      // Header redaction
      const headerMsg = "Failed at endpoint with x-goog-api-key: AIzaSyD-secret1234567890 and path /Users/dev/file.m4a";
      const sanitizedHeader = sanitizeErrorMessage(new Error(headerMsg));
      assert.ok(!sanitizedHeader.includes("AIzaSyD-"), "Header secret must be redacted");
      assert.ok(sanitizedHeader.includes("x-goog-api-key: ***"), "x-goog-api-key must be masked");
      assert.ok(sanitizedHeader.includes("[path]"), "Filesystem path must be redacted");

      // Preserved generic contract
      const genericMsg = "Failed with Bearer eyJhbGciOi... and /Users/test/dir/file.m4a";
      assert.equal(sanitizeErrorMessage(new Error(genericMsg)), "Failed with Bearer *** and [path]");

      // Safe identifier validators: valid models and providers
      assert.equal(validateSafeIdentifier("GEMINI"), "GEMINI");
      assert.equal(validateSafeIdentifier("OPENAI"), "OPENAI");
      assert.equal(validateSafeModelIdentifier("gemini-3.5-transcribe"), "gemini-3.5-transcribe");
      assert.equal(validateSafeModelIdentifier("whisper-1"), "whisper-1");

      // Permanent vs Retry classifications
      assert.ok(isPermanentError("GEMINI_NOT_CONFIGURED"), "GEMINI_NOT_CONFIGURED must be permanent");
      assert.ok(isPermanentError("GEMINI_AUTH_ERROR"), "GEMINI_AUTH_ERROR must be permanent");
      assert.ok(isPermanentError("GEMINI_INVALID_RESPONSE"), "GEMINI_INVALID_RESPONSE must be permanent");
      assert.ok(isPermanentError("GEMINI_TIMESTAMP_MISSING"), "GEMINI_TIMESTAMP_MISSING must be permanent");
      assert.ok(isPermanentError("GEMINI_AUDIO_TOO_LONG"), "GEMINI_AUDIO_TOO_LONG must be permanent");
      assert.ok(isPermanentError("AUDIO_TOO_LARGE"), "AUDIO_TOO_LARGE must be permanent");
      assert.ok(isPermanentError("INVALID_TRANSCRIPTION_PROVIDER"), "INVALID_TRANSCRIPTION_PROVIDER must be permanent");
      assert.ok(isPermanentError("INVALID_TRANSCRIPTION_MODEL"), "INVALID_TRANSCRIPTION_MODEL must be permanent");

      // Retryable
      assert.ok(!isPermanentError("GEMINI_TIMEOUT"), "GEMINI_TIMEOUT must be retryable");
      assert.ok(!isPermanentError("GEMINI_RATE_LIMITED"), "GEMINI_RATE_LIMITED must be retryable");
      assert.ok(!isPermanentError("GEMINI_PROVIDER_UNAVAILABLE"), "GEMINI_PROVIDER_UNAVAILABLE must be retryable");
      assert.ok(!isPermanentError("TIMEOUT"), "TIMEOUT must be retryable");
      assert.ok(!isPermanentError("RATE_LIMITED"), "RATE_LIMITED must be retryable");
    });

    // Requirement 5 (Unit): Safe identifier validators must reject invalid inputs rather than relabeling
    await testCase(
      "Section 3.1: Safe Validator Strict Rejection (Requirement 5)",
      () => {
        assert.throws(
          () => validateSafeModelIdentifier("bad model with spaces and ' quotes"),
          /INVALID_TRANSCRIPTION_MODEL/,
          "validateSafeModelIdentifier must throw INVALID_TRANSCRIPTION_MODEL for invalid models"
        );
        assert.throws(
          () => validateSafeIdentifier("bad; injection --"),
          /INVALID_TRANSCRIPTION_PROVIDER/,
          "validateSafeIdentifier must throw INVALID_TRANSCRIPTION_PROVIDER for invalid providers"
        );
      },
      "In features/zalo-transcription/service.ts, update validateSafeModelIdentifier and validateSafeIdentifier to throw INVALID_TRANSCRIPTION_MODEL / INVALID_TRANSCRIPTION_PROVIDER (or fail closed) instead of returning 'unknown-model' / 'UNKNOWN'."
    );

    // =========================================================================
    // Section 4: True PGlite Worker Integration Tests
    // =========================================================================
    console.log("\n--- Initializing PGlite Supabase Harness ---");
    const harness = await createPgliteSupabase();
    const db = harness.db;

    try {
      const companyA = randomUUID();
      const companyB = randomUUID();
      const bossA = randomUUID();
      const saleA = randomUUID();
      const customerA = randomUUID();
      const deviceA = randomUUID();
      const secretA = "s".repeat(44);

      // Seed companies, users, members, customers
      await db.query(
        "INSERT INTO companies(id, name) VALUES($1, 'Company A'), ($2, 'Company B')",
        [companyA, companyB]
      );

      for (const [id, role, comp] of [
        [bossA, "BOSS_ADMIN", companyA],
        [saleA, "SALE", companyA],
      ]) {
        await db.query("INSERT INTO auth.users(id) VALUES($1)", [id]);
        await db.query("INSERT INTO user_profiles(id, full_name) VALUES($1, 'User') ON CONFLICT(id) DO NOTHING", [id]);
        await db.query("INSERT INTO company_members(company_id, user_id, role, status) VALUES($1, $2, $3, 'ACTIVE')", [comp, id, role]);
      }

      await db.query(
        "INSERT INTO customers(id, company_id, name, source, stage) VALUES($1, $2, 'Khách Hàng A', 'ZALO', 'LEAD_NEW')",
        [customerA, companyA]
      );

      // Register device
      const devRes = await harness.client.rpc("zalo_manage_device", {
        p_company: companyA,
        p_actor: bossA,
        p_device: deviceA,
        p_name: "Macbook Test Device",
        p_hash: sha256(secretA),
        p_staff: saleA,
      });
      assert.ifError(devRes.error);

      // Storage mock setup
      const storageObjects = new Map<string, Buffer>();
      const adminClient = Object.assign(harness.client, {
        storage: {
          from: (bucket: string) => ({
            upload: async (path: string, body: Buffer) => {
              if (storageObjects.has(path)) return { error: { message: "exists" } };
              storageObjects.set(path, body);
              await db.query(
                "INSERT INTO storage.objects(bucket_id, name, metadata) VALUES($1, $2, $3)",
                [bucket, path, JSON.stringify({ size: body.length })]
              );
              return { error: null };
            },
            download: async (path: string) => {
              if (!storageObjects.has(path)) return { data: null, error: { message: "Object not found" } };
              return { data: new Blob([new Uint8Array(storageObjects.get(path)!)]), error: null };
            },
          }),
        },
      }) as unknown as SupabaseClient;

      const audioBytes = audioFixture();
      const originalChecksum = sha256(audioBytes);

      // -----------------------------------------------------------------------
      // Integration Test 4.1: Full Success with GEMINI provider & DB metadata
      // -----------------------------------------------------------------------
      await testCase("4.1: Full Success with GEMINI provider & DB metadata", async () => {
        const metaSuccess = metadataFixture(deviceA, "Khách Hàng A");
        const uploadRes = await uploadRecording(uploadRequest(metaSuccess, audioBytes, secretA), adminClient);
        assert.equal(uploadRes.duplicate, false);
        const callId = uploadRes.call_id;

        const claimRes = await adminClient.rpc("zalo_claim_transcription_jobs", {
          p_limit: 1,
          p_locked_by: "worker_test_gemini",
          p_lease_seconds: 300,
        });
        assert.ifError(claimRes.error);
        const claimedJobs = claimRes.data as ClaimedTranscriptionJob[];
        assert.equal(claimedJobs.length, 1);
        const job = claimedJobs[0];
        job.audio_validation = { ...job.audio_validation, duration: 2.0 };
        assert.equal(job.call_id, callId);

        let geminiCalls = 0;
        let receivedDurationMs: number | undefined;
        let receivedDeadline: number | undefined;

        const geminiMock = new MockTranscriptionProvider(
          (fileName, opts) => {
            geminiCalls++;
            receivedDurationMs = opts?.duration_ms;
            receivedDeadline = opts?.deadline;
            if (fileName.includes("customer")) {
              return {
                text: "Tôi muốn đặt mua cửa chống ngập inox",
                language: "vi",
                duration_ms: 1200,
                segments: [
                  { start_ms: 200, end_ms: 1200, text: "Tôi muốn đặt mua cửa chống ngập inox", confidence: 0.98 },
                ],
              };
            } else {
              return {
                text: "Dạ bên em có các mẫu cửa inox 304 tự động",
                language: "vi",
                duration_ms: 1800,
                segments: [
                  { start_ms: 1300, end_ms: 2800, text: "Dạ bên em có các mẫu cửa inox 304 tự động", confidence: 0.97 },
                ],
              };
            }
          },
          { name: "GEMINI", model: "gemini-3.5-transcribe" }
        );

        await processZaloTranscriptionJob(job, {
          client: adminClient,
          provider: geminiMock,
        });

        assert.equal(geminiCalls, 2, "Both LEFT (customer) and RIGHT (staff) channels transcribed");
        assert.equal(receivedDurationMs, 2000, "Validated audio duration converted to ms passed to provider");
        assert.ok(typeof receivedDeadline === "number" && receivedDeadline > Date.now(), "Worker deadline passed to provider");

        const txRow = (
          await db.query<{
            status: string;
            provider: string;
            model: string;
            full_transcript: string;
            completed_at: string | null;
            error_code: string | null;
          }>(
            "SELECT status, provider, model, full_transcript, completed_at, error_code FROM zalo_call_transcriptions WHERE id = $1",
            [job.id]
          )
        ).rows[0];

        assert.equal(txRow.status, "COMPLETED");
        assert.equal(txRow.provider, "GEMINI", "DB provider column must be GEMINI");
        assert.equal(txRow.model, "gemini-3.5-transcribe", "DB model column must be gemini-3.5-transcribe");
        assert.ok(txRow.completed_at !== null, "completed_at must be populated");
        assert.equal(txRow.error_code, null);
        assert.ok(txRow.full_transcript.includes("Tôi muốn đặt mua"));
        assert.ok(txRow.full_transcript.includes("Dạ bên em có"));

        const utterances = (
          await db.query<{
            speaker_role: string;
            channel: string;
            start_ms: number;
            end_ms: number;
            sequence: number;
            text: string;
          }>(
            "SELECT speaker_role, channel, start_ms, end_ms, sequence, text FROM zalo_call_transcript_utterances WHERE transcription_id = $1 ORDER BY sequence ASC",
            [job.id]
          )
        ).rows;

        assert.equal(utterances.length, 2);
        assert.equal(utterances[0].speaker_role, "CUSTOMER", "Left channel must be CUSTOMER");
        assert.equal(utterances[0].channel, "LEFT");
        assert.equal(utterances[0].start_ms, 200);
        assert.equal(utterances[0].sequence, 1);

        assert.equal(utterances[1].speaker_role, "STAFF", "Right channel must be STAFF");
        assert.equal(utterances[1].channel, "RIGHT");
        assert.equal(utterances[1].start_ms, 1300);
        assert.equal(utterances[1].sequence, 2);

        const downloadedAudio = await adminClient.storage.from(RECORDING_BUCKET).download(job.recording_path);
        assert.ifError(downloadedAudio.error);
        const downloadedBytes = Buffer.from(await downloadedAudio.data!.arrayBuffer());
        assert.equal(sha256(downloadedBytes), originalChecksum, "Original audio in Supabase storage must be immutable");
      });

      // -----------------------------------------------------------------------
      // Integration Test 4.2: Failure metadata persisted before upload (fenced)
      // -----------------------------------------------------------------------
      await testCase("4.2: Failure metadata persisted before upload", async () => {
        const metaFail = metadataFixture(deviceA, "Khách Hàng Lỗi");
        await uploadRecording(uploadRequest(metaFail, audioBytes, secretA), adminClient);

        const failClaimRes = await adminClient.rpc("zalo_claim_transcription_jobs", {
          p_limit: 1,
          p_locked_by: "worker_test_gemini",
          p_lease_seconds: 300,
        });
        const failJob = (failClaimRes.data as ClaimedTranscriptionJob[])[0];

        const geminiAuthFail = new MockTranscriptionProvider(
          () => {
            throw new Error("GEMINI_AUTH_ERROR");
          },
          { name: "GEMINI", model: "gemini-3.5-transcribe" }
        );

        await assert.rejects(
          () =>
            processZaloTranscriptionJob(failJob, {
              client: adminClient,
              provider: geminiAuthFail,
            }),
          /GEMINI_AUTH_ERROR/
        );

        const failTxRow = (
          await db.query<{
            status: string;
            provider: string;
            model: string;
            error_code: string;
            attempts: number;
          }>(
            "SELECT status, provider, model, error_code, attempts FROM zalo_call_transcriptions WHERE id = $1",
            [failJob.id]
          )
        ).rows[0];

        assert.equal(failTxRow.status, "FAILED", "GEMINI_AUTH_ERROR must be terminal FAILED");
        assert.equal(failTxRow.provider, "GEMINI", "Provider must be persisted as GEMINI");
        assert.equal(failTxRow.model, "gemini-3.5-transcribe", "Model must be persisted in DB");
        assert.equal(failTxRow.error_code, "GEMINI_AUTH_ERROR");
      });

      // -----------------------------------------------------------------------
      // Integration Test 4.3: Transient retry scheduling with GEMINI provider
      // -----------------------------------------------------------------------
      await testCase("4.3: Transient retry scheduling with GEMINI provider", async () => {
        const metaRetry = metadataFixture(deviceA, "Khách Hàng Retry");
        await uploadRecording(uploadRequest(metaRetry, audioBytes, secretA), adminClient);
        const retryJob = (
          (
            await adminClient.rpc("zalo_claim_transcription_jobs", {
              p_limit: 1,
              p_locked_by: "worker_test_gemini",
              p_lease_seconds: 300,
            })
          ).data as ClaimedTranscriptionJob[]
        )[0];

        const geminiRateLimit = new MockTranscriptionProvider(
          () => {
            throw new Error("GEMINI_RATE_LIMITED");
          },
          { name: "GEMINI", model: "gemini-3.5-transcribe" }
        );

        await assert.rejects(
          () =>
            processZaloTranscriptionJob(retryJob, {
              client: adminClient,
              provider: geminiRateLimit,
            }),
          /GEMINI_RATE_LIMITED/
        );

        const retryTxRow = (
          await db.query<{
            status: string;
            provider: string;
            model: string;
            attempts: number;
            next_run_at: string;
          }>(
            "SELECT status, provider, model, attempts, next_run_at FROM zalo_call_transcriptions WHERE id = $1",
            [retryJob.id]
          )
        ).rows[0];

        assert.equal(retryTxRow.status, "PENDING", "Transient GEMINI_RATE_LIMITED must remain PENDING for retry");
        assert.equal(retryTxRow.provider, "GEMINI");
        assert.equal(retryTxRow.model, "gemini-3.5-transcribe");
        assert.equal(retryTxRow.attempts, 1);
        assert.ok(new Date(retryTxRow.next_run_at).getTime() > Date.now(), "next_run_at must be in the future");
      });

      // -----------------------------------------------------------------------
      // Integration Test 4.4: Worker try/catch handles invalid provider resolution
      // -----------------------------------------------------------------------
      await testCase("4.4: Worker try/catch handles invalid provider resolution", async () => {
        const metaInvalid = metadataFixture(deviceA, "Khách Hàng Invalid Env");
        await uploadRecording(uploadRequest(metaInvalid, audioBytes, secretA), adminClient);
        const invalidJob = (
          (
            await adminClient.rpc("zalo_claim_transcription_jobs", {
              p_limit: 1,
              p_locked_by: "worker_test_gemini",
              p_lease_seconds: 300,
            })
          ).data as ClaimedTranscriptionJob[]
        )[0];

        const origTransEnv = process.env.TRANSCRIPTION_PROVIDER;
        try {
          process.env.TRANSCRIPTION_PROVIDER = "   ";
          await assert.rejects(
            () => processZaloTranscriptionJob(invalidJob, { client: adminClient }),
            /INVALID_TRANSCRIPTION_PROVIDER/
          );

          const invalidTxRow = (
            await db.query<{
              status: string;
              error_code: string;
            }>("SELECT status, error_code FROM zalo_call_transcriptions WHERE id = $1", [invalidJob.id])
          ).rows[0];

          assert.equal(invalidTxRow.status, "FAILED", "Invalid provider must fail closed, never stuck in PROCESSING");
          assert.equal(invalidTxRow.error_code, "INVALID_TRANSCRIPTION_PROVIDER");
        } finally {
          if (origTransEnv !== undefined) process.env.TRANSCRIPTION_PROVIDER = origTransEnv;
          else delete process.env.TRANSCRIPTION_PROVIDER;
        }
      });

      // -----------------------------------------------------------------------
      // Integration Test 4.5: Metadata RPC Positive & Comprehensive Negative Fencing (Requirement 2)
      // -----------------------------------------------------------------------
      await testCase(
        "4.5: Metadata RPC Positive & Negative Fencing (Requirement 2)",
        async () => {
          const metaRpc = metadataFixture(deviceA, "Khách Hàng RPC Fencing Matrix");
          await uploadRecording(uploadRequest(metaRpc, audioBytes, secretA), adminClient);
          const rpcClaimRes = await adminClient.rpc("zalo_claim_transcription_jobs", {
            p_limit: 1,
            p_locked_by: "worker_test_gemini",
            p_lease_seconds: 300,
          });
          const rpcJob = (rpcClaimRes.data as ClaimedTranscriptionJob[])[0];

          // 1. Positive update with active lease succeeds
          await db.query(
            "UPDATE zalo_call_transcriptions SET lease_expires_at = now() + interval '300 seconds' WHERE id = $1",
            [rpcJob.id]
          );
          const posRes = await adminClient.rpc("zalo_set_transcription_provider_metadata", {
            p_company: companyA,
            p_transcription_id: rpcJob.id,
            p_lock_token: rpcJob.lock_token,
            p_provider: "GEMINI",
            p_model: "gemini-3.5-transcribe",
          });
          assert.equal(posRes.error, null, "Positive update must succeed without error");
          assert.equal(posRes.data, true, "Positive update must return true");

          const posRow = (
            await db.query<{ provider: string; model: string }>(
              "SELECT provider, model FROM zalo_call_transcriptions WHERE id = $1",
              [rpcJob.id]
            )
          ).rows[0];
          assert.equal(posRow.provider, "GEMINI");
          assert.equal(posRow.model, "gemini-3.5-transcribe");

          // 2. Negative: Expired lease must fail
          await db.query(
            "UPDATE zalo_call_transcriptions SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
            [rpcJob.id]
          );
          const expRes = await adminClient.rpc("zalo_set_transcription_provider_metadata", {
            p_company: companyA,
            p_transcription_id: rpcJob.id,
            p_lock_token: rpcJob.lock_token,
            p_provider: "GEMINI",
            p_model: "gemini-3.5-transcribe",
          });
          assert.ok(
            expRes.error && /TRANSCRIPTION_LOCK_LOST/.test(expRes.error.message),
            "Expired lease must fail with TRANSCRIPTION_LOCK_LOST"
          );

          // 3. Negative: Wrong lock token must fail
          await db.query(
            "UPDATE zalo_call_transcriptions SET lease_expires_at = now() + interval '300 seconds' WHERE id = $1",
            [rpcJob.id]
          );
          const wrongTokenRes = await adminClient.rpc("zalo_set_transcription_provider_metadata", {
            p_company: companyA,
            p_transcription_id: rpcJob.id,
            p_lock_token: randomUUID(),
            p_provider: "GEMINI",
            p_model: "gemini-3.5-transcribe",
          });
          assert.ok(
            wrongTokenRes.error && /TRANSCRIPTION_LOCK_LOST/.test(wrongTokenRes.error.message),
            "Wrong lock_token must fail with TRANSCRIPTION_LOCK_LOST"
          );

          // 4. Negative: Status not PROCESSING must fail
          await db.query(
            "UPDATE zalo_call_transcriptions SET status = 'PENDING' WHERE id = $1",
            [rpcJob.id]
          );
          const nonProcessingRes = await adminClient.rpc("zalo_set_transcription_provider_metadata", {
            p_company: companyA,
            p_transcription_id: rpcJob.id,
            p_lock_token: rpcJob.lock_token,
            p_provider: "GEMINI",
            p_model: "gemini-3.5-transcribe",
          });
          assert.ok(
            nonProcessingRes.error && /TRANSCRIPTION_LOCK_LOST/.test(nonProcessingRes.error.message),
            "Status not PROCESSING must fail with TRANSCRIPTION_LOCK_LOST"
          );

          // Restore status to PROCESSING for NULL lease check
          await db.query(
            "UPDATE zalo_call_transcriptions SET status = 'PROCESSING' WHERE id = $1",
            [rpcJob.id]
          );

          // 5. Negative: NULL lease must fail (currently migration erroneously allows null)
          await db.query(
            "UPDATE zalo_call_transcriptions SET lease_expires_at = NULL WHERE id = $1",
            [rpcJob.id]
          );
          const nullLeaseRes = await adminClient.rpc("zalo_set_transcription_provider_metadata", {
            p_company: companyA,
            p_transcription_id: rpcJob.id,
            p_lock_token: rpcJob.lock_token,
            p_provider: "GEMINI",
            p_model: "gemini-3.5-transcribe",
          });
          assert.ok(
            nullLeaseRes.error && /TRANSCRIPTION_LOCK_LOST/.test(nullLeaseRes.error.message),
            "NULL lease_expires_at must fail with TRANSCRIPTION_LOCK_LOST (migration must require active lease, not allow NULL)"
          );
        },
        "In supabase/migrations/20261021150000_zalo_transcription_provider_model.sql, update zalo_set_transcription_provider_metadata WHERE clause from `AND (lease_expires_at IS NULL OR lease_expires_at > now())` to `AND lease_expires_at IS NOT NULL AND lease_expires_at > now()`."
      );

      // -----------------------------------------------------------------------
      // Integration Test 4.6: Cross-tenant isolation on ACTIVE lease (Requirement 1)
      // -----------------------------------------------------------------------
      await testCase("4.6: Cross-tenant isolation on active lease (Requirement 1)", async () => {
        const metaCross = metadataFixture(deviceA, "Khách Hàng Cross Tenant Active Lease");
        await uploadRecording(uploadRequest(metaCross, audioBytes, secretA), adminClient);
        const crossClaimRes = await adminClient.rpc("zalo_claim_transcription_jobs", {
          p_limit: 1,
          p_locked_by: "worker_test_gemini",
          p_lease_seconds: 300,
        });
        const crossJob = (crossClaimRes.data as ClaimedTranscriptionJob[])[0];

        // Ensure active lease is definitely valid and active
        await db.query(
          "UPDATE zalo_call_transcriptions SET lease_expires_at = now() + interval '300 seconds' WHERE id = $1",
          [crossJob.id]
        );

        const beforeCrossRow = (
          await db.query<{ provider: string; model: string | null; updated_at: Date | string }>(
            "SELECT provider, model, updated_at FROM zalo_call_transcriptions WHERE id = $1",
            [crossJob.id]
          )
        ).rows[0];

        // Tenant B attempts to set metadata on Tenant A's transcription with active lease and valid lock token
        const crossTenantRes = await adminClient.rpc("zalo_set_transcription_provider_metadata", {
          p_company: companyB,
          p_transcription_id: crossJob.id,
          p_lock_token: crossJob.lock_token,
          p_provider: "GEMINI",
          p_model: "gemini-3.5-transcribe",
        });

        assert.ok(
          crossTenantRes.error && /TRANSCRIPTION_LOCK_LOST/.test(crossTenantRes.error.message),
          "Cross-tenant metadata RPC invocation must return TRANSCRIPTION_LOCK_LOST"
        );

        // Verify DB row remains completely unchanged
        const afterCrossRow = (
          await db.query<{ provider: string; model: string | null; updated_at: Date | string }>(
            "SELECT provider, model, updated_at FROM zalo_call_transcriptions WHERE id = $1",
            [crossJob.id]
          )
        ).rows[0];

        assert.equal(afterCrossRow.provider, beforeCrossRow.provider, "Cross-tenant call must not mutate provider");
        assert.equal(afterCrossRow.model, beforeCrossRow.model, "Cross-tenant call must not mutate model");
        assert.deepEqual(afterCrossRow.updated_at, beforeCrossRow.updated_at, "Cross-tenant call must not mutate updated_at");
      });

      // -----------------------------------------------------------------------
      // Integration Test 4.7: ACL & Permission Checks with actual function execution (Requirement 3)
      // -----------------------------------------------------------------------
      await testCase("4.7: ACL & Permission Checks with actual SET ROLE execution (Requirement 3)", async () => {
        const dummyCompany = randomUUID();
        const dummyTx = randomUUID();
        const dummyToken = randomUUID();

        // 1. Attempt execution with anon role in transaction
        await db.query("BEGIN;");
        try {
          await db.query("SET ROLE anon;");
          let anonExecuted = false;
          try {
            await db.query(
              "SELECT public.zalo_set_transcription_provider_metadata($1::uuid, $2::uuid, $3::uuid, $4::text, $5::text)",
              [dummyCompany, dummyTx, dummyToken, "GEMINI", "gemini-3.5-transcribe"]
            );
            anonExecuted = true;
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            assert.match(
              message,
              /permission denied for function zalo_set_transcription_provider_metadata/i,
              "anon execution must be denied with permission denied"
            );
          }
          assert.equal(anonExecuted, false, "anon role must NOT be permitted to execute zalo_set_transcription_provider_metadata");
        } finally {
          await db.query("ROLLBACK;");
        }

        // 2. Attempt execution with authenticated role in transaction
        await db.query("BEGIN;");
        try {
          await db.query("SET ROLE authenticated;");
          let authExecuted = false;
          try {
            await db.query(
              "SELECT public.zalo_set_transcription_provider_metadata($1::uuid, $2::uuid, $3::uuid, $4::text, $5::text)",
              [dummyCompany, dummyTx, dummyToken, "GEMINI", "gemini-3.5-transcribe"]
            );
            authExecuted = true;
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            assert.match(
              message,
              /permission denied for function zalo_set_transcription_provider_metadata/i,
              "authenticated execution must be denied with permission denied"
            );
          }
          assert.equal(authExecuted, false, "authenticated role must NOT be permitted to execute zalo_set_transcription_provider_metadata");
        } finally {
          await db.query("ROLLBACK;");
        }

        // 3. Routine privileges in information_schema
        const permQuery = await db.query<{ grantee: string; privilege_type: string }>(
          "SELECT grantee, privilege_type FROM information_schema.routine_privileges WHERE routine_name = 'zalo_set_transcription_provider_metadata'"
        );
        const grantees = new Set(permQuery.rows.map((r) => r.grantee));
        assert.ok(!grantees.has("public"), "PUBLIC must not have execute on metadata RPC");
        assert.ok(!grantees.has("anon"), "anon must not have execute on metadata RPC");
        assert.ok(!grantees.has("authenticated"), "authenticated must not have execute on metadata RPC");

        // 4. Column privileges in information_schema: authenticated CAN select model column
        const colPermQuery = await db.query<{ grantee: string; column_name: string }>(
          "SELECT grantee, column_name FROM information_schema.column_privileges WHERE table_name = 'zalo_call_transcriptions' AND column_name = 'model'"
        );
        const colGrantees = new Set(colPermQuery.rows.map((r) => r.grantee));
        assert.ok(colGrantees.has("authenticated"), "authenticated role must be granted SELECT on model column");
      });

      // -----------------------------------------------------------------------
      // Integration Test 4.8: Worker Metadata RPC Fault Injection (Requirement 4)
      // -----------------------------------------------------------------------
      async function executeMetadataRpcFaultTest(
        faultName: string,
        faultResponse: { data: unknown; error: { message: string; code?: string } | null }
      ) {
        const meta = metadataFixture(deviceA, `Khách Hàng Fault ${faultName}`);
        await uploadRecording(uploadRequest(meta, audioBytes, secretA), adminClient);
        const claimRes = await adminClient.rpc("zalo_claim_transcription_jobs", {
          p_limit: 1,
          p_locked_by: "worker_test_gemini",
          p_lease_seconds: 300,
        });
        const faultJob = (claimRes.data as ClaimedTranscriptionJob[])[0];

        let providerCalls = 0;
        const trackingProvider = new MockTranscriptionProvider(
          () => {
            providerCalls++;
            return { text: "should not be called", language: "vi", duration_ms: 1000, segments: [] };
          },
          { name: "GEMINI", model: "gemini-3.5-transcribe" }
        );

        // RPC override intercepts only zalo_set_transcription_provider_metadata, preserving zalo_fail_transcription
        const faultClient = harness.withRpcOverride((fn, _params) => {
          if (fn === "zalo_set_transcription_provider_metadata") {
            return faultResponse;
          }
          return null;
        });
        Object.assign(faultClient, { storage: adminClient.storage });

        let workerThrew = false;
        try {
          await processZaloTranscriptionJob(faultJob, {
            client: faultClient,
            provider: trackingProvider,
          });
        } catch {
          workerThrew = true;
        }

        assert.equal(
          workerThrew,
          true,
          `Worker must reject when metadata RPC returns ${faultName}`
        );
        assert.equal(
          providerCalls,
          0,
          `Provider must NEVER be called when metadata RPC returns ${faultName} (zero calls)`
        );

        const dbRow = (
          await db.query<{ status: string; completed_at: string | null }>(
            "SELECT status, completed_at FROM zalo_call_transcriptions WHERE id = $1",
            [faultJob.id]
          )
        ).rows[0];

        assert.notEqual(
          dbRow.status,
          "COMPLETED",
          `Job must not be COMPLETED when metadata RPC returns ${faultName}`
        );
        assert.equal(
          dbRow.completed_at,
          null,
          `completed_at must remain null when metadata RPC returns ${faultName}`
        );
      }

      await testCase("4.8.1: Metadata RPC Error Outcome Prevents Provider (Requirement 4)", async () => {
        await executeMetadataRpcFaultTest("error", { data: null, error: { message: "FAULT_RPC_ERROR" } });
      });

      await testCase(
        "4.8.2: Metadata RPC False Outcome Prevents Provider (Requirement 4)",
        async () => {
          await executeMetadataRpcFaultTest("false", { data: false, error: null });
        },
        "In features/zalo-transcription/service.ts, verify `data` returned from zalo_set_transcription_provider_metadata: if `error || data !== true`, throw new Error(`PERSIST_METADATA_FAILED: ...`) so false outcome prevents provider calls."
      );

      await testCase(
        "4.8.3: Metadata RPC Null Outcome Prevents Provider (Requirement 4)",
        async () => {
          await executeMetadataRpcFaultTest("null", { data: null, error: null });
        },
        "In features/zalo-transcription/service.ts, verify `data` returned from zalo_set_transcription_provider_metadata: if `error || !data`, throw new Error(`PERSIST_METADATA_FAILED: ...`) so null outcome prevents provider calls."
      );

      // -----------------------------------------------------------------------
      // Integration Test 4.9: Adversarial Model Injection & Credential Leak Defense (Requirement 5)
      // -----------------------------------------------------------------------
      await testCase(
        "4.9: Adversarial Model Injection & Credential Leak Defense (Requirement 5)",
        async () => {
          const metaLeak = metadataFixture(deviceA, "Khách Hàng Adversarial Model Leak Test");
          await uploadRecording(uploadRequest(metaLeak, audioBytes, secretA), adminClient);
          const leakClaimRes = await adminClient.rpc("zalo_claim_transcription_jobs", {
            p_limit: 1,
            p_locked_by: "worker_test_gemini",
            p_lease_seconds: 300,
          });
          const leakJob = (leakClaimRes.data as ClaimedTranscriptionJob[])[0];

          const fakeGoogleKey = "AIza" + "x".repeat(35);
          const badModelWithSpacesAndKey = `gemini-pro /Users/sensitive/path ${fakeGoogleKey}`;

          let leakProviderCalls = 0;
          const leakMockProvider = new MockTranscriptionProvider(
            () => {
              leakProviderCalls++;
              return { text: "should not be called", language: "vi", duration_ms: 1000, segments: [] };
            },
            { name: "GEMINI", model: badModelWithSpacesAndKey }
          );

          const interceptedLogs: string[] = [];
          const origLog = console.log;
          const origInfo = console.info;
          const origWarn = console.warn;
          const origError = console.error;

          const captureLog = (...args: unknown[]) => {
            const line = args
              .map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a)))
              .join(" ");
            interceptedLogs.push(line);
          };

          console.log = captureLog;
          console.info = captureLog;
          console.warn = captureLog;
          console.error = captureLog;

          let leakWorkerError: Error | null = null;
          try {
            await processZaloTranscriptionJob(leakJob, {
              client: adminClient,
              provider: leakMockProvider,
            });
          } catch (err: unknown) {
            leakWorkerError = err instanceof Error ? err : new Error(String(err));
          } finally {
            console.log = origLog;
            console.info = origInfo;
            console.warn = origWarn;
            console.error = origError;
          }

          // 1. Assert worker failed with sanitized INVALID_TRANSCRIPTION_MODEL
          assert.ok(
            leakWorkerError !== null,
            "Worker must throw when provider model identifier is invalid"
          );
          assert.match(
            leakWorkerError.message,
            /INVALID_TRANSCRIPTION_MODEL/,
            "Worker error message must be sanitized INVALID_TRANSCRIPTION_MODEL"
          );

          // 2. Assert zero provider calls
          assert.equal(
            leakProviderCalls,
            0,
            "Zero provider calls must be made when model identifier is invalid"
          );

          // 3. Assert no raw model or API key leaked in console logs
          for (const logLine of interceptedLogs) {
            assert.ok(
              !logLine.includes(fakeGoogleKey),
              `Google API key leaked into log output: ${logLine}`
            );
            assert.ok(
              !logLine.includes("/Users/sensitive/path"),
              `Sensitive path leaked into log output: ${logLine}`
            );
            assert.ok(
              !logLine.includes(badModelWithSpacesAndKey),
              `Raw unvalidated model string leaked into log output: ${logLine}`
            );
          }

          // 4. Assert DB state: status FAILED, error_code INVALID_TRANSCRIPTION_MODEL, no leaked secrets
          const leakDbRow = (
            await db.query<{
              status: string;
              error_code: string;
              error_message: string | null;
              model: string | null;
            }>(
              "SELECT status, error_code, error_message, model FROM zalo_call_transcriptions WHERE id = $1",
              [leakJob.id]
            )
          ).rows[0];

          assert.equal(leakDbRow.status, "FAILED", "Job must be marked FAILED on invalid model");
          assert.equal(
            leakDbRow.error_code,
            "INVALID_TRANSCRIPTION_MODEL",
            "DB error_code must be INVALID_TRANSCRIPTION_MODEL"
          );
          assert.ok(
            !leakDbRow.error_message?.includes(fakeGoogleKey),
            "Google API key must not leak into DB error_message"
          );
          assert.ok(
            !leakDbRow.model?.includes(fakeGoogleKey),
            "Google API key must not leak into DB model column"
          );
        },
        "In features/zalo-transcription/service.ts, in processZaloTranscriptionJob, validate provider.model strictly. If invalid, throw new Error('INVALID_TRANSCRIPTION_MODEL') before logging or invoking metadata/provider, rather than relabeling to 'unknown-model' and proceeding."
      );

      // -----------------------------------------------------------------------
      // Integration Test 4.10: Explicit Job Deadline 0 Boundary Condition (Requirement 7)
      // -----------------------------------------------------------------------
      await testCase(
        "4.10: Explicit Job Deadline 0 Boundary Condition (Requirement 7)",
        async () => {
          const metaDeadline = metadataFixture(deviceA, "Khách Hàng Deadline Zero Test");
          await uploadRecording(uploadRequest(metaDeadline, audioBytes, secretA), adminClient);
          const dlClaimRes = await adminClient.rpc("zalo_claim_transcription_jobs", {
            p_limit: 1,
            p_locked_by: "worker_test_gemini",
            p_lease_seconds: 300,
          });
          const dlJob = (dlClaimRes.data as ClaimedTranscriptionJob[])[0];

          let dlProviderCalls = 0;
          const dlMockProvider = new MockTranscriptionProvider(
            () => {
              dlProviderCalls++;
              return { text: "should not be called", language: "vi", duration_ms: 1000, segments: [] };
            },
            { name: "GEMINI", model: "gemini-3.5-transcribe" }
          );

          let dlError: Error | null = null;
          try {
            await processZaloTranscriptionJob(dlJob, {
              client: adminClient,
              provider: dlMockProvider,
              deadline: 0,
            });
          } catch (err: unknown) {
            dlError = err instanceof Error ? err : new Error(String(err));
          }

          assert.ok(dlError !== null, "Worker must throw TIMEOUT when deadline: 0 is provided");
          assert.match(
            dlError.message,
            /TIMEOUT/,
            "Worker must fail with TIMEOUT when deadline: 0"
          );
          assert.equal(
            dlProviderCalls,
            0,
            "Deadline 0 must abort before ANY provider call is made (zero calls)"
          );

          const dlDbRow = (
            await db.query<{ status: string; error_code: string }>(
              "SELECT status, error_code FROM zalo_call_transcriptions WHERE id = $1",
              [dlJob.id]
            )
          ).rows[0];

          assert.notEqual(
            dlDbRow.status,
            "COMPLETED",
            "Job must not be COMPLETED when deadline: 0"
          );
          assert.equal(dlDbRow.error_code, "TIMEOUT", "DB error_code must be TIMEOUT");
        },
        "In features/zalo-transcription/service.ts, compute jobDeadline as `typeof options?.deadline === 'number' ? Math.min(options.deadline, Date.now() + MAX_SINGLE_JOB_DURATION_MS) : Date.now() + MAX_SINGLE_JOB_DURATION_MS` instead of `options?.deadline || ...` so 0 is not treated as falsey."
      );
    } finally {
      await harness.close();
    }
  } finally {
    restoreInitialEnv();
  }

  // =========================================================================
  // Final Results & Failure Reporting
  // =========================================================================
  if (failures.length > 0) {
    console.error(`\n=========================================================`);
    console.error(`SUMMARY: ${failures.length} test(s) failed:`);
    for (const f of failures) {
      console.error(`\n- [${f.name}]`);
      console.error(`  Error: ${f.error.message}`);
      if (f.expectedFix) {
        console.error(`  Expected fix: ${f.expectedFix}`);
      }
    }
    console.error(`=========================================================`);
    throw new Error(
      `${failures.length} test(s) failed. See report above for details.`
    );
  } else {
    console.log("\n=========================================================");
    console.log("ALL DUAL PROVIDER & PGLITE INTEGRATION TESTS PASSED!");
    console.log("=========================================================");
  }
}

run().catch((err) => {
  console.error("FATAL TEST FAILURE:", err);
  process.exit(1);
});
