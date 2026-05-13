const { Router } = require('express');
const { download, health } = require('../controllers/audio.controller');

const router = Router();

router.get('/health', health);
router.post('/download', download);

module.exports = router;
