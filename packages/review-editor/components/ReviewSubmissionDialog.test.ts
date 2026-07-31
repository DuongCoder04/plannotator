import { describe, expect, test } from 'bun:test';
import {
  buildPRActionRequest,
  buildPlatformReviewBody,
  type SubmissionTarget,
} from './ReviewSubmissionDialog';

const inlineComment: SubmissionTarget['fileComments'][number] = {
  path: 'src/example.ts',
  line: 12,
  side: 'RIGHT',
  body: 'Handle the error here.',
};

describe('buildPlatformReviewBody', () => {
  test('contains only user-authored top-level feedback when present', () => {
    expect(buildPlatformReviewBody('comment', 'github', 'Overall feedback', {
      fileComments: [inlineComment],
      fileScopedBody: '**src/example.ts:** File-level feedback',
    })).toBe('Overall feedback\n\n**src/example.ts:** File-level feedback');
  });

  test('uses a neutral GitHub body for an inline-only comment review', () => {
    expect(buildPlatformReviewBody('comment', 'github', '   ', {
      fileComments: [inlineComment],
      fileScopedBody: '',
    })).toBe('See inline comments.');
  });

  test('does not manufacture a GitLab note for inline-only comments', () => {
    expect(buildPlatformReviewBody('comment', 'gitlab', undefined, {
      fileComments: [inlineComment],
      fileScopedBody: '',
    })).toBe('');
  });

  test('does not manufacture an approval body', () => {
    expect(buildPlatformReviewBody('approve', 'github', undefined, {
      fileComments: [inlineComment],
      fileScopedBody: '',
    })).toBe('');
  });
});

describe('buildPRActionRequest', () => {
  const target: SubmissionTarget = {
    prUrl: 'https://gitlab.example/acme/widgets/-/merge_requests/7',
    prNumber: 7,
    prTitle: 'Reliable comments',
    prRepo: 'acme/widgets',
    fileComments: [inlineComment, { ...inlineComment, path: 'src/posted.ts', line: 30 }],
    fileScopedBody: '',
    fileCount: 2,
    annotationCount: 2,
    status: 'pending',
  };

  test('uses the complete original payload before any platform mutation', () => {
    expect(buildPRActionRequest('comment', 'Overall review', target)).toEqual({
      action: 'comment',
      body: 'Overall review',
      fileComments: target.fileComments,
      targetPrUrl: target.prUrl,
    });
  });

  test('uses only the server-authorized retry after a partial submission', () => {
    const partialTarget: SubmissionTarget = {
      ...target,
      status: 'partial',
      partial: {
        status: 'partial',
        postedFileCommentCount: 1,
        failedFileComments: [{
          comment: inlineComment,
          error: 'rejected',
        }],
        reviewBodyPosted: true,
        approval: 'succeeded',
        retry: {
          action: 'comment',
          fileComments: [inlineComment],
        },
      },
    };

    expect(buildPRActionRequest('approve', 'Do not repost this', partialTarget)).toEqual({
      action: 'comment',
      body: '',
      fileComments: [inlineComment],
      targetPrUrl: target.prUrl,
    });
  });

  test('refuses a partial target without a server-authorized retry', () => {
    expect(() => buildPRActionRequest('comment', 'Do not post', {
      ...target,
      status: 'partial',
    })).toThrow('missing its server-authorized retry');
  });
});
