require('dotenv').config();
const express = require('express');
const multer = require('multer');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const OpenAI = require('openai');
const ffmpeg = require('fluent-ffmpeg');
const cors = require('cors');
const authController = require('./controllers/authController');
const auth = require('./middleware/auth');

const app = express();

// CORS configuration

const corsOptions = {
  origin: function (origin, callback) {
    const allowedOrigins = ['http://localhost:5173', 'https://your-production-frontend.com'];
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true)
    } else {
      callback(new Error('Not allowed by CORS'))
    }
  },
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI ||"mongodb://127.0.0.1:27017/videoeditor")
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB connection error:', err));

const upload = multer({ dest: 'uploads/' });


const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.use(express.json());

// Video processing functions
const cutVideo = (inputPath, startTime, endTime, outputPath) => {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .setStartTime(startTime)
      .setDuration(endTime - startTime)
      .output(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', (err) => reject(err))
      .run();
  });
};

const removeAudioFromVideo = (inputPath, outputPath) => {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .noAudio()
      .output(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', (err) => reject(err))
      .run();
  });
};

// Auth routes
app.post('/api/signup', authController.signup);
app.post('/api/login', authController.login);

// Protected route example
app.get('/api/protected', auth, (req, res) => {
  res.json({ msg: 'This is a protected route' });
});

// API Endpoints
app.post('/api/upload', upload.single('video'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No video file uploaded' });
  }
  res.json({ filename: req.file.filename });
});

app.post('/api/process', async (req, res) => {
  const { prompt, filename } = req.body;
  const inputPath = path.join(__dirname, 'uploads', filename);

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: "You are a helpful assistant that can extract video cutting, splitting, muting, and unmuting instructions from user prompts. Respond in JSON format with an object containing 'action', 'start', 'end', and 'inputVideo' properties as needed."
        },
        {
          role: "user",
          content: `Analyze this prompt and provide the appropriate video editing instructions: "${prompt}"`
        }
      ],
      temperature: 0.7,
    });

    const responseContent = completion.choices[0].message.content;
    if (!responseContent) {
      throw new Error('No content in OpenAI response');
    }

    const parsedResponse = JSON.parse(responseContent);
    const { action, start, end } = parsedResponse;

    let outputPaths = [];
    let nlpResponse = '';

    switch (action) {
      case 'cut':
        const cutOutputPath = path.join(__dirname, 'output', `cut_${Date.now()}.mp4`);
        await cutVideo(inputPath, start, end, cutOutputPath);
        outputPaths.push(cutOutputPath);
        nlpResponse = `Video cut from ${start} seconds to ${end} seconds.`;
        break;
      case 'split':
        for (let i = 0; i < start.length; i++) {
          const splitOutputPath = path.join(__dirname, 'output', `split_${i + 1}_${Date.now()}.mp4`);
          await cutVideo(inputPath, start[i], end[i], splitOutputPath);
          outputPaths.push(splitOutputPath);
          nlpResponse += `Video part ${i + 1} cut from ${start[i]} to ${end[i]} seconds.\n`;
        }
        nlpResponse += 'All video parts cut successfully!';
        break;
      case 'mute':
        const muteOutputPath = path.join(__dirname, 'output', `muted_${Date.now()}.mp4`);
        await removeAudioFromVideo(inputPath, muteOutputPath);
        outputPaths.push(muteOutputPath);
        nlpResponse = 'Video audio has been muted.';
        break;
      case 'unmute':
        nlpResponse = 'Video audio has been unmuted.';
        break;
      default:
        throw new Error('Unrecognized action');
    }

    res.json({ success: true, nlpResponse, outputPaths });
  } catch (error) {
    console.error('Error processing video:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/download/:filename', (req, res) => {
  const filePath = path.join(__dirname, 'output', req.params.filename);
  res.download(filePath, (err) => {
    if (err) {
      res.status(500).send('Error downloading file');
    }
    // Optionally delete the file after download
    fs.unlink(filePath, (unlinkErr) => {
      if (unlinkErr) console.error('Error deleting file:', unlinkErr);
    });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));