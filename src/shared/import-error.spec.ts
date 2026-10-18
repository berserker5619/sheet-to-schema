import { ImportError, type ImportErrorCode } from './import-error';

describe('ImportError', () => {
  it('answers 500 for a code outside the closed set, which only an untyped caller can pass', () => {
    expect(new ImportError('NOT_A_CODE' as ImportErrorCode, 'x').status).toBe(500);
  });

  it('keeps a cause for the logger and details for the envelope, and neither when not given', () => {
    const cause = new Error('inner');
    const error = new ImportError('INVALID_PLAN', 'Bad plan.', { cause, details: [{ code: 'PLAN_GROUP' }] });
    expect((error as { cause?: unknown }).cause).toBe(cause);
    expect(error.details).toEqual([{ code: 'PLAN_GROUP' }]);

    const bare = new ImportError('NO_FILE', 'No file.');
    expect('cause' in bare).toBe(false);
    expect(bare.details).toBeUndefined();
  });
});
