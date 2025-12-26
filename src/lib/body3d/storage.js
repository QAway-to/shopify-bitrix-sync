// File storage management for uploads and results

const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const STORAGE_ROOT = path.join(process.cwd(), 'storage');
const UPLOADS_DIR = path.join(STORAGE_ROOT, 'uploads');
const RESULTS_DIR = path.join(STORAGE_ROOT, 'results');
const TEMP_DIR = path.join(STORAGE_ROOT, 'temp');

// Ensure directories exist
async function ensureDirectories() {
  const dirs = [STORAGE_ROOT, UPLOADS_DIR, RESULTS_DIR, TEMP_DIR];
  for (const dir of dirs) {
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (error) {
      // Directory might already exist, ignore error
      if (error.code !== 'EEXIST') {
        throw error;
      }
    }
  }
}

/**
 * Generate a unique job ID
 * @returns {string} UUID v4
 */
function generateJobId() {
  return uuidv4();
}

/**
 * Save uploaded video file
 * @param {Buffer|Stream} fileData - File data
 * @param {string} jobId - Job identifier
 * @param {string} originalFilename - Original filename
 * @returns {Promise<string>} Path to saved file
 */
async function saveUploadedVideo(fileData, jobId, originalFilename) {
  await ensureDirectories();
  
  const ext = path.extname(originalFilename) || '.mp4';
  const filename = `${jobId}${ext}`;
  const filePath = path.join(UPLOADS_DIR, filename);
  
  // If fileData is a Buffer, write it directly
  if (Buffer.isBuffer(fileData)) {
    await fs.writeFile(filePath, fileData);
  } else {
    // If it's a stream, we need to handle it differently
    // For now, assume it's a Buffer
    await fs.writeFile(filePath, fileData);
  }
  
  return filePath;
}

/**
 * Get path to uploaded video
 * @param {string} jobId - Job identifier
 * @returns {Promise<string|null>} Path to video file or null if not found
 */
async function getUploadedVideoPath(jobId) {
  await ensureDirectories();
  
  // Try common video extensions
  const extensions = ['.mp4', '.mov', '.avi'];
  for (const ext of extensions) {
    const filePath = path.join(UPLOADS_DIR, `${jobId}${ext}`);
    try {
      await fs.access(filePath);
      return filePath;
    } catch (error) {
      // File doesn't exist, try next extension
      continue;
    }
  }
  
  return null;
}

/**
 * Create results directory for job
 * @param {string} jobId - Job identifier
 * @returns {Promise<string>} Path to results directory
 */
async function createResultsDirectory(jobId) {
  await ensureDirectories();
  
  const resultsPath = path.join(RESULTS_DIR, jobId);
  await fs.mkdir(resultsPath, { recursive: true });
  
  return resultsPath;
}

/**
 * Save results (OBJ file and JSON)
 * @param {string} jobId - Job identifier
 * @param {string} objContent - OBJ file content
 * @param {object} measurements - Measurements JSON object
 * @returns {Promise<{objPath: string, jsonPath: string}>} Paths to saved files
 */
async function saveResults(jobId, objContent, measurements) {
  await ensureDirectories();
  
  const resultsDir = await createResultsDirectory(jobId);
  const objPath = path.join(resultsDir, 'model.obj');
  const jsonPath = path.join(resultsDir, 'measurements.json');
  
  // Save OBJ file
  await fs.writeFile(objPath, objContent, 'utf8');
  
  // Save JSON file
  const jsonData = {
    jobId,
    ...measurements,
    createdAt: new Date().toISOString()
  };
  await fs.writeFile(jsonPath, JSON.stringify(jsonData, null, 2), 'utf8');
  
  return { objPath, jsonPath, resultsDir };
}

/**
 * Get results directory path
 * @param {string} jobId - Job identifier
 * @returns {string} Path to results directory
 */
function getResultsDirectory(jobId) {
  return path.join(RESULTS_DIR, jobId);
}

/**
 * Get OBJ file path
 * @param {string} jobId - Job identifier
 * @returns {string} Path to OBJ file
 */
function getObjFilePath(jobId) {
  return path.join(RESULTS_DIR, jobId, 'model.obj');
}

/**
 * Get JSON file path
 * @param {string} jobId - Job identifier
 * @returns {string} Path to JSON file
 */
function getJsonFilePath(jobId) {
  return path.join(RESULTS_DIR, jobId, 'measurements.json');
}

/**
 * Check if results exist for a job
 * @param {string} jobId - Job identifier
 * @returns {Promise<boolean>} True if results exist
 */
async function resultsExist(jobId) {
  try {
    const objPath = getObjFilePath(jobId);
    const jsonPath = getJsonFilePath(jobId);
    
    await fs.access(objPath);
    await fs.access(jsonPath);
    
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Read measurements JSON
 * @param {string} jobId - Job identifier
 * @returns {Promise<object>} Measurements object
 */
async function readMeasurements(jobId) {
  const jsonPath = getJsonFilePath(jobId);
  const content = await fs.readFile(jsonPath, 'utf8');
  return JSON.parse(content);
}

/**
 * Clean up old files (uploads and results)
 * @param {number} days - Age in days
 */
async function cleanupOldFiles(days = 7) {
  await ensureDirectories();
  
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  
  // Clean uploads
  try {
    const uploadFiles = await fs.readdir(UPLOADS_DIR);
    for (const file of uploadFiles) {
      const filePath = path.join(UPLOADS_DIR, file);
      const stats = await fs.stat(filePath);
      if (stats.mtimeMs < cutoff) {
        await fs.unlink(filePath);
      }
    }
  } catch (error) {
    console.error('Error cleaning uploads:', error);
  }
  
  // Clean results
  try {
    const resultDirs = await fs.readdir(RESULTS_DIR);
    for (const dir of resultDirs) {
      const dirPath = path.join(RESULTS_DIR, dir);
      const stats = await fs.stat(dirPath);
      if (stats.mtimeMs < cutoff) {
        await fs.rm(dirPath, { recursive: true, force: true });
      }
    }
  } catch (error) {
    console.error('Error cleaning results:', error);
  }
}

module.exports = {
  generateJobId,
  saveUploadedVideo,
  getUploadedVideoPath,
  createResultsDirectory,
  saveResults,
  getResultsDirectory,
  getObjFilePath,
  getJsonFilePath,
  resultsExist,
  readMeasurements,
  cleanupOldFiles,
  ensureDirectories
};

