

module.exports = async srv => {
  const {BusinessPartnerAddress, Notifications, Addresses, BusinessPartner} = srv.entities;
  const bupaSrv = await cds.connect.to("API_BUSINESS_PARTNER");
  const messaging = await cds.connect.to('messaging')
  const namespace = messaging.options.credentials && messaging.options.credentials.namespace

  const {postcodeValidator} = require('postcode-validator');
  
  srv.on("READ", BusinessPartnerAddress, req => bupaSrv.tx(req).run(req.query))
  srv.on("READ", BusinessPartner, req => bupaSrv.tx(req).run(req.query))

  messaging.on(["refapps/bpems/abc/S4H/BO/BusinessPartner/Created", "refapps/bpems/abc/ce/sap/s4/beh/businesspartner/v1/BusinessPartner/Created/v1"], async msg => {
    console.log("<< create event caught", msg.data);
    let BUSINESSPARTNER = "";
    if(msg.headers && msg.headers.specversion == "1.0"){
       //> Fix for 2020 on-premise
      BUSINESSPARTNER = (+(msg.data.BusinessPartner)).toString();
    }
    else{
      BUSINESSPARTNER = (+(msg.data.KEY[0].BUSINESSPARTNER)).toString();
    }
    console.log(BUSINESSPARTNER);
    const bpEntity = await bupaSrv.tx(msg).run(SELECT.one(BusinessPartner).where({businessPartnerId: BUSINESSPARTNER}));
    const result = await cds.tx(msg).run(INSERT.into(Notifications).entries({businessPartnerId:BUSINESSPARTNER, verificationStatus_code:'N', businessPartnerName:bpEntity.businessPartnerName}));
    const address = await bupaSrv.tx(msg).run(SELECT.one(BusinessPartnerAddress).where({businessPartnerId: BUSINESSPARTNER}));
    // for the address to notification association - extra field
    if(address){
      const notificationObj = await cds.tx(msg).run(SELECT.one(Notifications).columns("ID").where({businessPartnerId: BUSINESSPARTNER}));
      address.notifications_id=notificationObj.ID;
      const res = await cds.tx(msg).run(INSERT.into(Addresses).entries(address));
      console.log("Address inserted");
    }
  });

  messaging.on(["refapps/bpems/abc/S4H/BO/BusinessPartner/Changed", "refapps/bpems/abc/ce/sap/s4/beh/businesspartner/v1/BusinessPartner/Changed/v1"], async msg => {
    console.log("<< change event caught", msg.data);
    let BUSINESSPARTNER=""
    if(msg.headers && msg.headers.specversion == "1.0"){
       //> Fix for 2020 on-premise
        BUSINESSPARTNER = (+(msg.data.BusinessPartner)).toString();
    }
    else{
       BUSINESSPARTNER = (+(msg.data.KEY[0].BUSINESSPARTNER)).toString();
    }
    const bpIsAlive = await cds.tx(msg).run(SELECT.one(Notifications, (n) => n.verificationStatus_code).where({businessPartnerId: BUSINESSPARTNER}));
    if(bpIsAlive && bpIsAlive.verificationStatus_code == "V"){
      const bpMarkVerified= await cds.tx(msg).run(UPDATE(Notifications).where({businessPartnerId: BUSINESSPARTNER}).set({verificationStatus_code:"C"}));
      console.log("<< BP marked verified >>")
    }    
    
  });

  srv.after("UPDATE", "Notifications", (data, req) => {
    console.log("Notification update", data.businessPartnerId);
    if(data.verificationStatus_code === "V" || data.verificationStatus_code === "INV")
    emitEvent(data, req);
  });

  srv.before("SAVE", "Notifications", req => {
    if(req.data.verificationStatus_code == "C"){
      req.error({code: '400', message: "Cannot mark as COMPLETED. Please change to VERIFIED", numericSeverity:2, target: 'verificationStatus_code'});
    }
  });

  srv.before("PATCH", "Addresses", req => {
    // To set whether address is Edited
    req.data.isModified = true;
  });

  srv.after("PATCH", "Addresses", (data, req) => {
    const isValidPinCode = postcodeValidator(data.postalCode, data.country);
    if(!isValidPinCode){
      return req.error({code: '400', message: "invalid postal code", numericSeverity:2, target: 'postalCode'});
    } 
    return req.info({numericSeverity:1, target: 'postalCode'});  
  });

  async function emitEvent(result, req){
    const resultJoin =  await cds.tx(req).run(SELECT.one("my.businessPartnerValidation.Notifications as N").leftJoin("my.businessPartnerValidation.Addresses as A").on("N.businessPartnerId = A.businessPartnerId").where({"N.ID": result.ID}));
    const statusValues={"N":"NEW", "P":"PROCESS", "INV":"INVALID", "V":"VERIFIED"}
    // Format JSON as per serverless requires
    const payload = {
      "businessPartner": resultJoin.businessPartnerId,
      "businessPartnerName": resultJoin.businessPartnerName,
      "verificationStatus": statusValues[resultJoin.verificationStatus_code],
      "addressId":  resultJoin.addressId,
      "streetName":  resultJoin.streetName,
      "postalCode":  resultJoin.postalCode,
      "country":  resultJoin.country,
      "addressModified":  resultJoin.isModified
    }
    console.log("<< formatted >>>>>", payload);
    messaging.tx(req).emit(`${namespace}/SalesService/d41d/BusinessPartnerVerified`, payload)
  }

  
}
