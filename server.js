const express = require('express');
const path = require('path');
const bcrypt = require('bcrypt');
const mongoose = require('mongoose');
const User = require('./models/user');
const session = require('express-session');
const cors = require('cors');
const PDFDocument = require('pdfkit');
const fs = require('fs');

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.set('view engine', 'ejs');

app.use(session({
  secret: "timetable-secret",
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 30 * 60 * 1000 }   // 30 minutes
}));

app.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

// ── MongoDB ──────────────────────────────────────────────────────────────────
mongoose.connect('mongodb+srv://harishraj:5777@cluster0.qa6dzty.mongodb.net/')
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.log(err));

// ── Auth middleware ──────────────────────────────────────────────────────────
function auth(req, res, next) {
  if (req.session.userid) return next();
  return res.redirect('/?error=Session expired, please login again');
}

// ── Helper: parse AI response into structured timetable HTML ─────────────────
function parseToTableHTML(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  let html = '';
  let inTable = false;

  for (const line of lines) {
    // Detect markdown table rows  |...|...|
    if (line.startsWith('|')) {
      const cells = line.split('|').map(c => c.trim()).filter(Boolean);
      // Skip separator rows like |---|---|
      if (cells.every(c => /^[-:]+$/.test(c))) continue;

      if (!inTable) {
        html += '<table><thead><tr>';
        cells.forEach(c => { html += `<th>${c}</th>`; });
        html += '</tr></thead><tbody>';
        inTable = true;
      } else {
        html += '<tr>';
        cells.forEach(c => { html += `<td>${c}</td>`; });
        html += '</tr>';
      }
    } else {
      if (inTable) { html += '</tbody></table>'; inTable = false; }
      html += `<p style="margin-bottom:8px;color:rgba(245,240,232,0.7);font-size:13px;">${line}</p>`;
    }
  }
  if (inTable) html += '</tbody></table>';
  return html || `<pre style="white-space:pre-wrap;font-size:13px;">${text}</pre>`;
}

// ── Routes ───────────────────────────────────────────────────────────────────
app.get('/check-session', (req, res) => res.json(req.session));

app.get('/', (req, res) => {
  res.render('login', { error: req.query.error || null, success: req.query.success || null });
});

app.get('/ai', auth, (req, res) => {
  res.render('AI', { error: req.query.error || null, success: req.query.success || null });
});

app.get('/register', (req, res) => {
  res.render('register', { error: req.query.error || null, success: req.query.success || null });
});

// ── Login ─────────────────────────────────────────────────────────────────────
app.post('/', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.redirect('/?error=Please provide email and password');

  const user = await User.findOne({ email });
  if (!user) return res.redirect('/?error=Email does not exist');

  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.redirect('/?error=Incorrect email or password');

  req.session.userid = user._id;
  res.redirect('/ai');
});

// ── Register ──────────────────────────────────────────────────────────────────
app.post('/register', async (req, res) => {
  const { email, password } = req.body;
  const ifexist = await User.findOne({ email });
  if (ifexist) return res.redirect('/register?error=Email already registered');

  const hashed = await bcrypt.hash(password, 10);
  await new User({ email, password: hashed }).save();
  res.redirect('/?success=Account created! Please login');
});

// ── Generate Timetable ────────────────────────────────────────────────────────
app.post('/ai', auth, async (req, res) => {
  try {
    const {
      subjects, days, hours,
      numberOfClasses, classNames,
      facultyName, subjectTaken, availableDays, facultyHours,
      year, section, workingDays, periodsPerDay,
      startTime, endTime, duration, breakTime, lunchTime
    } = req.body;

    if (!subjects || !days || !hours || !numberOfClasses) {
      return res.redirect('/ai?error=Please fill in all required fields');
    }

    // classNames may be a single string or array (multiple inputs with same name)
    const classNamesArr = Array.isArray(classNames)
      ? classNames
      : classNames ? [classNames] : [];

    const numClasses = parseInt(numberOfClasses) || 1;

    // Build faculty list for legend
    const facultyNamesArr  = facultyName  ? facultyName.split(',').map(s => s.trim())  : [];
    const subjectTakenArr  = subjectTaken ? subjectTaken.split(',').map(s => s.trim()) : [];
    const facultyList = facultyNamesArr.map((name, i) => ({
      name,
      subject: subjectTakenArr[i] || ''
    }));

    // ── Build one prompt per class and call Ollama ─────────────────────────
    const timetables = [];

    for (let i = 0; i < numClasses; i++) {
      const className = classNamesArr[i] || `Class ${i + 1}`;

      const prompt = `
Generate a weekly academic timetable for ${className}.

Subjects: ${subjects}
Days per week: ${days}
Hours per day: ${hours}
Faculty: ${facultyName || 'N/A'}
Subject taken by faculty: ${subjectTaken || 'N/A'}
Available days of faculty: ${availableDays || 'all days'}
Faculty available for: ${facultyHours || hours} hours/day
Start time: ${startTime || '09:00'}
End time: ${endTime || '17:00'}
Duration per class: ${duration || 50} mins
Morning break: ${breakTime || 15} mins
Lunch break: ${lunchTime || 45} mins
Number of periods per day: ${periodsPerDay || 'auto'}

Rules:
- Output ONLY a markdown table with columns: Day | Period 1 | Period 2 | ... (based on periods per day / hours)
- Do NOT repeat a subject in consecutive periods
- Distribute subjects evenly across the week
- Include faculty name in brackets after the subject e.g. Maths (Dr. Rajan)
- Mark Break and Lunch rows clearly
- No explanations or extra text outside the table
`;

      const ollamaResponse = await fetch("http://localhost:11434/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "llama3", prompt, stream: false })
      });

      const data = await ollamaResponse.json();
      const rawText = data.response || '';

      timetables.push({
        className,
        html: parseToTableHTML(rawText),
        raw: rawText
      });
    }

    // Store in session for PDF download
    const timetableId = Date.now().toString();
    req.session.timetableData = {
      id: timetableId,
      timetables,
      facultyList,
      year, section,
      numberOfClasses: numClasses,
      generatedAt: new Date().toISOString()
    };

    res.render('timetable', {
      timetables,
      facultyList,
      year, section,
      numberOfClasses: numClasses,
      timetableId,
      timetableRaw: timetables.map(t => t.raw).join('\n\n---\n\n')
    });

  } catch (err) {
    console.error('Timetable generation error:', err);
    res.redirect('/ai?error=Failed to generate timetable. Is Ollama running?');
  }
});

// ── PDF Download ──────────────────────────────────────────────────────────────
app.get('/timetable/pdf', auth, (req, res) => {
  const data = req.session.timetableData;
  if (!data) return res.redirect('/ai?error=No timetable found. Please generate one first.');

  const doc = new PDFDocument({ margin: 50, size: 'A4' });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="timetable-${data.id}.pdf"`);
  doc.pipe(res);

  // ── PDF Header ────────────────────────────────────────────────────────────
  doc.rect(0, 0, doc.page.width, 80).fill('#0a0a0f');
  doc.fillColor('#c9a84c')
     .fontSize(22)
     .font('Helvetica-Bold')
     .text('TimeTable AI', 50, 22);
  doc.fillColor('#f5f0e8')
     .fontSize(10)
     .font('Helvetica')
     .text('AI-Generated Academic Timetable', 50, 50);
  doc.fillColor('#c9a84c')
     .text(`Generated: ${new Date(data.generatedAt).toLocaleDateString('en-IN')}`, 350, 22)
     .text(`Classes: ${data.numberOfClasses}`, 350, 38)
     .text(data.year ? `Year: ${data.year}` : '', 350, 54);

  doc.moveDown(3);

  // ── Each Timetable ────────────────────────────────────────────────────────
  data.timetables.forEach((tt, idx) => {
    if (idx > 0) { doc.addPage(); }

    // Class title
    doc.fillColor('#0a0a0f')
       .rect(50, doc.y, doc.page.width - 100, 30).fill('#c9a84c');
    doc.fillColor('#0a0a0f')
       .font('Helvetica-Bold')
       .fontSize(13)
       .text(tt.className || `Class ${idx + 1}`, 60, doc.y - 22);
    doc.moveDown(1.5);

    // Raw timetable text (clean up markdown for PDF)
    const cleaned = tt.raw
      .replace(/\|[-:]+\|[-:\s|]*/g, '')   // remove separator rows
      .replace(/\|/g, '  |  ')              // space out pipe chars
      .trim();

    doc.fillColor('#111111')
       .font('Courier')
       .fontSize(8)
       .text(cleaned, 50, doc.y, {
         width: doc.page.width - 100,
         lineGap: 4
       });

    doc.moveDown(2);
  });

  // ── Faculty Legend ────────────────────────────────────────────────────────
  if (data.facultyList && data.facultyList.length > 0) {
    doc.addPage();
    doc.fillColor('#c9a84c')
       .font('Helvetica-Bold')
       .fontSize(16)
       .text('Faculty Legend', 50, 60);
    doc.moveDown(0.5);
    doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y)
       .strokeColor('#c9a84c').lineWidth(0.5).stroke();
    doc.moveDown(0.5);

    data.facultyList.forEach(f => {
      doc.fillColor('#333333')
         .font('Helvetica-Bold')
         .fontSize(11)
         .text(f.name, 50, doc.y, { continued: true });
      doc.fillColor('#666666')
         .font('Helvetica')
         .text(`  →  ${f.subject}`);
      doc.moveDown(0.3);
    });
  }

  // ── Footer ────────────────────────────────────────────────────────────────
  const pages = doc.bufferedPageRange();
  for (let i = 0; i < pages.count; i++) {
    doc.switchToPage(pages.start + i);
    doc.fillColor('#aaaaaa')
       .font('Helvetica')
       .fontSize(8)
       .text(
         `TimeTable AI  •  Page ${i + 1} of ${pages.count}`,
         50, doc.page.height - 30,
         { align: 'center', width: doc.page.width - 100 }
       );
  }

  doc.end();
});

// ── Server ────────────────────────────────────────────────────────────────────
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});