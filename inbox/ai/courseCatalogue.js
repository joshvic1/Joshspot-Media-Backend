function withCourseDefaults(records) {
 const courses=require('./defaults').records.filter(r=>['ads_video_course','whatsapp_status_course'].includes(r.key));
 return [...records,...courses.filter(course=>!records.some(r=>r.key===course.key)).map(course=>({...course,enabled:true,archived:false,revision:0}))];
}
module.exports = {withCourseDefaults};
