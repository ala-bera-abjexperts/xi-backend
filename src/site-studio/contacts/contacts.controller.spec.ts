import { ContactsController } from './contacts.controller';

const user = {
  userId: 'user-1',
  organizationId: 'org-1',
};

function responseMock() {
  return {
    setHeader: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  };
}

describe('ContactsController', () => {
  let service: Record<string, jest.Mock>;
  let controller: ContactsController;

  beforeEach(() => {
    service = {
      exportContactsCsv: jest.fn().mockResolvedValue('id,email\n1,a@test.dev'),
      getContacts: jest.fn().mockResolvedValue({ data: [] }),
      deleteContact: jest.fn().mockResolvedValue(undefined),
    };
    controller = new ContactsController(service as any);
  });

  it('exports contacts as a CSV attachment', async () => {
    const res = responseMock();

    await controller.exportContacts(user as any, 'funnel-1', res as any);

    expect(service.exportContactsCsv).toHaveBeenCalledWith('funnel-1', 'org-1');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv');
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      'attachment; filename="contacts-funnel-1.csv"',
    );
    expect(res.send).toHaveBeenCalledWith('id,email\n1,a@test.dev');
  });

  it('delegates contact listing with funnel and organization scope', async () => {
    const dto = { page: 2, pageSize: 10 };

    await controller.getContacts(user as any, 'funnel-1', dto as any);

    expect(service.getContacts).toHaveBeenCalledWith('funnel-1', 'org-1', dto);
  });

  it('returns undefined for no-content delete after delegating', async () => {
    await expect(
      controller.deleteContact(user as any, 'contact-1'),
    ).resolves.toBeUndefined();
    expect(service.deleteContact).toHaveBeenCalledWith(
      'contact-1',
      'org-1',
      'user-1',
    );
  });
});
