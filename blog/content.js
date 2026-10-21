const sanitize = require('sanitize-html');
const imageUrl = value => typeof value === 'string' && (/^\/api\/blog\/images\/[a-f\d]{24}$/.test(value) || /^https:\/\/[^\s<>"']+$/i.test(value));
function clean(html) {
  return sanitize(String(html || ''), {
    allowedTags: ['p','br','h2','h3','h4','strong','b','em','i','u','s','blockquote','ul','ol','li','a','img','hr','pre','code','table','thead','tbody','tr','th','td','span'],
    allowedAttributes: { a:['href','title','target','rel'], img:['src','alt','title','width','height','loading'], ol:['start'], td:['colspan','rowspan'], th:['colspan','rowspan'], '*':['style'] },
    allowedSchemes:['https','http','mailto','tel'], allowProtocolRelative:false,
    allowedStyles:{'*':{'text-align':[/^(left|center|right|justify)$/],color:[/^#[\da-f]{3,8}$/i,/^rgb\([\d ,]+\)$/], 'background-color':[/^#[\da-f]{3,8}$/i,/^rgb\([\d ,]+\)$/]}},
    transformTags:{h1:'h2',a:(tag,attrs)=>({tagName:'a',attribs:{...attrs,rel:'noopener noreferrer',target:'_blank'}}),img:(tag,attrs)=>({tagName:'img',attribs:{...attrs,loading:'lazy'}})},
    exclusiveFilter: frame => frame.tag === 'img' && !imageUrl(frame.attribs.src),
  });
}
const plain = html => sanitize(String(html || '').replace(/<\/(?:p|h[1-6]|li|blockquote|tr)>/gi,'$& '),{allowedTags:[],allowedAttributes:{}}).replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/\s+/g,' ').trim();
const invalid = message => { const error=new Error(message); error.status=400; throw error; };
function validate(body) {
  const title=String(body.title || '').trim(), slug=String(body.slug || '').trim().toLowerCase();
  if (!title || title.length>160) invalid('Enter a title of up to 160 characters.');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length>180) invalid('Use a short URL with lowercase letters, numbers and hyphens.');
  if (!['draft','published'].includes(body.status)) invalid('Choose draft or published.');
  if (typeof body.html!=='string' || body.html.length>500000) invalid('Article content is too large.');
  const html=clean(body.html);
  if (body.status==='published' && !plain(html)) invalid('Add some article text before publishing.');
  if (body.cover && !imageUrl(body.cover)) invalid('Choose a valid cover image.');
  return {title,slug,html,status:body.status,cover:body.cover || '',coverAlt:String(body.coverAlt || '').slice(0,240),excerpt:String(body.excerpt || plain(html)).slice(0,300),category:String(body.category || 'Insights').trim().slice(0,60),seoTitle:String(body.seoTitle || '').slice(0,160),seoDescription:String(body.seoDescription || '').slice(0,300)};
}
module.exports={clean,plain,validate,imageUrl};
