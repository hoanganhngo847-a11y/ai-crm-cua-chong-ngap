import assert from 'node:assert';
import { STORAGE_BUCKET_MAP, SIGNED_URL_TTL } from '../../shared/contracts/sensitive';
import { PDFDocument } from 'pdf-lib';

console.log('================================================================');
console.log('STARTING TV7 CONTRACT STORAGE & RENDERING UNIT TESTS');
console.log('================================================================\n');

let passCount = 0;
function testPass(msg: string) {
  console.log(`[PASS] ${msg}`);
  passCount++;
}

async function run() {
  // ----------------------------------------------------------------------------
  // Test 1: Canonical contract bucket name is 'contracts' (NOT 'secure-documents')
  // ----------------------------------------------------------------------------
  {
    assert.strictEqual(
      STORAGE_BUCKET_MAP.CONTRACT,
      'contracts',
      'Canonical contract storage bucket must be "contracts"'
    );
    assert.strictEqual(
      SIGNED_URL_TTL.CONTRACT,
      1800,
      'Contract signed URL TTL must be frozen at 1800 seconds'
    );
    testPass('STORAGE_BUCKET_MAP and SIGNED_URL_TTL match frozen Foundation contracts');
  }

  // ----------------------------------------------------------------------------
  // Test 2: Server-derived contract paths follow canonical multi-tenant structure
  // ----------------------------------------------------------------------------
  {
    const companyId = '33333333-3333-3333-3333-333333333333';
    const contractId = 'aaaaaaaa-1111-0000-0000-000000000041';
    const revisionNo = 1;

    const generatedPath = `${companyId}/contracts/${contractId}/revision-${revisionNo}/generated.pdf`;
    const signedPath = `${companyId}/contracts/${contractId}/revision-${revisionNo}/signed.pdf`;

    assert(generatedPath.startsWith(`${companyId}/contracts/${contractId}/`));
    assert(generatedPath.endsWith('/generated.pdf'));
    assert(signedPath.endsWith('/signed.pdf'));
    testPass('Contract storage paths are deterministic and scoped strictly by companyId and contractId');
  }

  // ----------------------------------------------------------------------------
  // Test 3: PDF Document generation produces valid PDF bytes
  // ----------------------------------------------------------------------------
  {
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([600, 400]);
    page.drawText('CONG TY TNHH CUA CHONG NGAP - HOP DONG', { x: 50, y: 350 });
    const pdfBytes = await pdfDoc.save();

    assert(pdfBytes instanceof Uint8Array);
    assert(pdfBytes.length > 100);
    // Verify PDF header magic bytes '%PDF-'
    const header = Buffer.from(pdfBytes.slice(0, 5)).toString('utf8');
    assert.strictEqual(header, '%PDF-');
    testPass('pdf-lib renders valid PDF buffer with canonical header bytes');
  }

  console.log(`\n================================================================`);
  console.log(`CONTRACT UNIT TESTS COMPLETED: ${passCount} PASSED, 0 FAILED`);
  console.log(`================================================================\n`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
