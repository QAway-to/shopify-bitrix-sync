// In-memory queue for processing jobs

const jobs = new Map();

const STATUS = {
  QUEUED: 'queued',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  ERROR: 'error'
};

/**
 * Create a new job
 * @param {string} jobId - Unique job identifier
 * @param {object} data - Job data (videoPath, height, gender, etc.)
 * @returns {object} Job object
 */
function createJob(jobId, data) {
  const job = {
    jobId,
    status: STATUS.QUEUED,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...data
  };
  
  jobs.set(jobId, job);
  return job;
}

/**
 * Get job by ID
 * @param {string} jobId - Job identifier
 * @returns {object|null} Job object or null if not found
 */
function getJob(jobId) {
  return jobs.get(jobId) || null;
}

/**
 * Update job status
 * @param {string} jobId - Job identifier
 * @param {string} status - New status
 * @param {object} data - Additional data to update
 * @returns {object|null} Updated job or null if not found
 */
function updateJob(jobId, status, data = {}) {
  const job = jobs.get(jobId);
  if (!job) {
    return null;
  }
  
  Object.assign(job, {
    status,
    updatedAt: new Date().toISOString(),
    ...data
  });
  
  jobs.set(jobId, job);
  return job;
}

/**
 * Get all jobs (for debugging/admin)
 * @returns {Array} Array of all jobs
 */
function getAllJobs() {
  return Array.from(jobs.values());
}

/**
 * Clear completed/error jobs older than specified hours
 * @param {number} hours - Age in hours
 */
function clearOldJobs(hours = 24) {
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
  
  for (const [jobId, job] of jobs.entries()) {
    if (
      (job.status === STATUS.COMPLETED || job.status === STATUS.ERROR) &&
      new Date(job.updatedAt) < cutoff
    ) {
      jobs.delete(jobId);
    }
  }
}

module.exports = {
  STATUS,
  createJob,
  getJob,
  updateJob,
  getAllJobs,
  clearOldJobs
};

