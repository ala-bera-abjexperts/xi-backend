import { contentDispositionAttachment } from './content-disposition';

describe('contentDispositionAttachment', () => {
  it('emits the RFC 5987 dual form for a German filename', () => {
    const header = contentDispositionAttachment('Änderung März.csv');

    // ASCII fallback never carries a non-ASCII byte (Node rejects non-Latin-1 header values,
    // and Latin-1 accents arrive as mojibake).
    expect(header).toContain('filename="_nderung M_rz.csv"');
    expect(header).toContain("filename*=UTF-8''%C3%84nderung%20M%C3%A4rz.csv");
  });

  it('survives a CJK name that would crash res.setHeader outright', () => {
    const header = contentDispositionAttachment('報告書.xlsx');

    expect(header).not.toMatch(/[^\x20-\x7e]/);
    expect(header).toContain(
      "filename*=UTF-8''%E5%A0%B1%E5%91%8A%E6%9B%B8.xlsx",
    );
  });

  it('neutralises header-injection characters', () => {
    const header = contentDispositionAttachment('bad"\r\nname.txt');

    expect(header).not.toContain('\r');
    expect(header).not.toContain('\n');
    expect(header).toContain('filename="bad___name.txt"');
  });
});
