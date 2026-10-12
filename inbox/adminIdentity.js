// Reserved internal recipient; not a staff login or an AI/unassigned owner.
const ID='000000000000000000000001';
module.exports={ID,person:{_id:ID,name:'Administrator',role:'ADMIN'},recipient:actor=>actor.admin?ID:actor.id,pushRecipient:id=>String(id)===ID?'admin':String(id)};
