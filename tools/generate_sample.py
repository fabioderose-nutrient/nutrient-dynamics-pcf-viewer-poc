"""Generate samples/data-handling-policy.pdf, a fictitious six-page company policy with an
acknowledgement form on the last page (text fields and a checkbox).

It is the kind of document a Dynamics 365 record points to when a company needs proof that
an employee opened and read it, which is what the control's audit trail records.

Requirements: Python 3.9+ and reportlab (pip install reportlab).
Run from the repository root: python tools/generate_sample.py
"""

from pathlib import Path

from reportlab.lib.colors import Color, black, white
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas

OUT = Path(__file__).resolve().parent.parent / "samples" / "data-handling-policy.pdf"
W, H = A4
LEFT, RIGHT = 70, W - 70
ACCENT = Color(0.15, 0.32, 0.55)

SECTIONS = [
    ("1. Purpose", [
        "This policy explains how employees of Example Corp handle customer, supplier and "
        "employee data in their daily work. It applies to every system, device and paper "
        "record that holds such data, wherever the work is done.",
        "The policy supports the commitments the company makes to its customers in its "
        "contracts and to the authorities under data protection law. Breaking it can harm "
        "the people whose data we hold, and the company.",
    ]),
    ("2. Scope", [
        "The policy covers all employees, contractors and temporary staff. Managers make sure "
        "that new team members read it during their first week and confirm it on the last "
        "page of this document.",
        "Separate procedures cover the IT department's administration tasks and the handling "
        "of payment card data. They complement this policy and do not replace it.",
    ]),
    ("3. Data classification", [
        "Every document and data set has one of four levels: Public, Internal, Confidential "
        "and Restricted. The level is set by the owner of the data and shown in the header of "
        "documents or in the metadata of the system that holds them.",
        "Public data can be shared freely. Internal data stays within the company. "
        "Confidential data is shared only with people who need it for their work. Restricted "
        "data, such as health or salary information, is shared only with named people and "
        "always encrypted.",
    ]),
    ("4. Storage and transfer", [
        "Company data is stored only in approved systems: the document management system, "
        "the CRM and the shared drives. Personal cloud storage, private e-mail accounts and "
        "removable media must not be used for company data.",
        "Confidential and Restricted data is sent outside the company only through the secure "
        "file transfer portal or as an encrypted attachment. The password is sent through a "
        "different channel than the file.",
    ]),
    ("5. Access", [
        "Access rights follow the principle of least privilege. Each employee receives the "
        "access needed for the current role, and managers review the rights of their team "
        "twice a year.",
        "Accounts are personal. Passwords and access cards are never shared, and screens are "
        "locked whenever a workstation is left unattended, even for a short time.",
    ]),
    ("6. Retention and deletion", [
        "Data is kept only as long as the retention schedule allows. Customer records are kept "
        "for seven years after the end of the contract, application files of candidates who "
        "were not hired for six months.",
        "At the end of the retention period, data is deleted from all systems, including "
        "copies on shared drives. Paper records are shredded in the locked bins on each floor.",
    ]),
    ("7. Incidents", [
        "A lost laptop, an e-mail sent to the wrong person or a suspicious login are incidents. "
        "Report them at once to the service desk, even outside office hours. The data "
        "protection team decides whether the authorities or the people concerned must be "
        "informed.",
        "Reporting an incident quickly is never held against the person who reports it. Hiding "
        "an incident is a breach of this policy.",
    ]),
    ("8. Training", [
        "Every employee completes the online data protection course each year. Teams that "
        "handle Restricted data attend an additional workshop. Completion is recorded in the "
        "learning platform.",
    ]),
]


def wrap(text, font, size, width):
    lines, line = [], ""
    for word in text.split():
        trial = f"{line} {word}".strip()
        if stringWidth(trial, font, size) > width and line:
            lines.append(line)
            line = word
        else:
            line = trial
    if line:
        lines.append(line)
    return lines


def frame(c, page, total):
    c.setFillColor(ACCENT)
    c.rect(0, H - 60, W, 60, stroke=0, fill=1)
    c.setFillColor(white)
    c.setFont("Helvetica-Bold", 13)
    c.drawString(LEFT, H - 36, "Example Corp  |  Data Handling Policy")
    c.setFont("Helvetica", 9)
    c.drawRightString(RIGHT, H - 36, "Version 3.1  -  Internal")
    c.setFillColor(Color(0.45, 0.45, 0.45))
    c.setFont("Helvetica", 8.5)
    c.drawString(LEFT, 36, "Fictitious sample document")
    c.drawRightString(RIGHT, 36, f"Page {page} of {total}")
    c.setFillColor(black)


def main():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    c = canvas.Canvas(str(OUT), pagesize=A4)
    c.setTitle("Data Handling Policy (fictitious sample)")
    c.setAuthor("Example Corp")
    c.setCreator("tools/generate_sample.py")
    total = 6
    page = 1

    # title page
    frame(c, page, total)
    c.setFont("Helvetica-Bold", 30)
    c.drawString(LEFT, H - 230, "Data Handling Policy")
    c.setFont("Helvetica", 14)
    c.setFillColor(Color(0.3, 0.3, 0.3))
    c.drawString(LEFT, H - 260, "How we protect customer, supplier and employee data")
    c.setFillColor(black)
    y = H - 330
    for label, value in [("Owner", "Data protection team"), ("Applies to", "All employees and contractors"),
                         ("Effective from", "1 January 2026"), ("Review cycle", "Yearly")]:
        c.setFont("Helvetica-Bold", 11)
        c.drawString(LEFT, y, label)
        c.setFont("Helvetica", 11)
        c.drawString(LEFT + 120, y, value)
        y -= 22
    y -= 20
    c.setFont("Helvetica", 11)
    for line in wrap("Read the whole policy, then complete and sign the acknowledgement form on "
                     "the last page. Your manager receives a confirmation once the form is saved.",
                     "Helvetica", 11, RIGHT - LEFT):
        c.drawString(LEFT, y, line)
        y -= 16
    c.showPage()

    # policy sections, two per page
    for i in range(0, len(SECTIONS), 2):
        page += 1
        frame(c, page, total)
        y = H - 110
        for title, paragraphs in SECTIONS[i:i + 2]:
            c.setFont("Helvetica-Bold", 15)
            c.setFillColor(ACCENT)
            c.drawString(LEFT, y, title)
            c.setFillColor(black)
            y -= 26
            for para in paragraphs:
                for line in wrap(para, "Helvetica", 11, RIGHT - LEFT):
                    c.setFont("Helvetica", 11)
                    c.drawString(LEFT, y, line)
                    y -= 16
                y -= 10
            y -= 24
        c.showPage()

    # acknowledgement form
    page += 1
    frame(c, page, total)
    c.setFont("Helvetica-Bold", 18)
    c.drawString(LEFT, H - 120, "Acknowledgement")
    c.setFont("Helvetica", 11)
    y = H - 150
    for line in wrap("By signing this form you confirm that you have read the Data Handling Policy, "
                     "that you understand it, and that you will follow it in your daily work.",
                     "Helvetica", 11, RIGHT - LEFT):
        c.drawString(LEFT, y, line)
        y -= 16
    form = c.acroForm
    y -= 30
    for label, name in [("Full name", "fullName"), ("Department", "department"), ("Date", "date")]:
        c.setFont("Helvetica-Bold", 11)
        c.drawString(LEFT, y + 6, label)
        form.textfield(name=name, x=LEFT + 120, y=y, width=280, height=22, borderWidth=1,
                       borderColor=Color(0.6, 0.6, 0.6), fillColor=Color(0.97, 0.97, 1), fontSize=11)
        y -= 40
    form.checkbox(name="readAndUnderstood", x=LEFT, y=y, size=16, borderWidth=1,
                  borderColor=Color(0.4, 0.4, 0.4), fillColor=white, buttonStyle="check")
    c.setFont("Helvetica", 11)
    c.drawString(LEFT + 26, y + 4, "I have read and understood the Data Handling Policy.")
    y -= 50
    c.setFont("Helvetica-Bold", 11)
    c.drawString(LEFT, y + 6, "Signature")
    c.setStrokeColor(Color(0.6, 0.6, 0.6))
    c.line(LEFT + 120, y, LEFT + 400, y)
    c.showPage()
    c.save()
    print("written", OUT)


if __name__ == "__main__":
    main()
