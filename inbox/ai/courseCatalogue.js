function withCourseDefaults(records) {
 const course = require('./defaults').records.find(r => r.key === 'whatsapp_status_course');
 return records.some(r => r.key === course.key) ? records : [...records, {...course, enabled:true, archived:false, revision:0}];
}
module.exports = {withCourseDefaults};
