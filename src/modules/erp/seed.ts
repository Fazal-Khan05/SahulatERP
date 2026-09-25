import { DEMO_TENANT, PARTNER_TENANT, type Workspace } from "./types";
export function blankWorkspace(demo=true): Workspace {
  return {schemaVersion:1,tenantId:demo?DEMO_TENANT:PARTNER_TENANT,revision:0,demo,
    company:{name:demo?"Sahulat Trading Co.":"Design Partner",taxId:demo?"DEMO-7321946":"",address:"Shahrah-e-Faisal, Karachi, Pakistan",currency:"PKR",logo:"S"},
    branches:[{id:"karachi",name:"Karachi"},{id:"lahore",name:"Lahore"}],
    warehouses:[{id:"khi-main",name:"Karachi · Main",branchId:"karachi"},{id:"khi-port",name:"Karachi · Port",branchId:"karachi"},{id:"lhe-main",name:"Lahore · Distribution",branchId:"lahore"}],
    parties:[],items:[],employees:[],documents:[],journals:[],stockMoves:[],receipts:[],plans:[],commissions:[],commissionMovements:[],shipments:[],payrolls:[],fbr:[],audit:[],bankLines:[],operations:[],periods:[],
    settings:{taxRate:"18",employerEobi:"5",employeeEobi:"1",eobiBase:"37000",incomeTaxRate:"5",numbering:"ST",approvalLimit:"500000"}};
}
export function seedMasters(): Workspace {
  const w=blankWorkspace();
  w.parties=[
    {id:"c-1",name:"Al-Noor Electronics",type:"customer",city:"Karachi",email:"accounts@alnoor.example",taxId:"DEMO-1234567",registered:true,creditLimit:"1500000",terms:30,customerClass:"Distributor"},
    {id:"c-2",name:"Metro Home Stores",type:"customer",city:"Lahore",email:"finance@metro.example",taxId:"DEMO-2345678",registered:true,creditLimit:"2500000",terms:45,customerClass:"Retailer"},
    {id:"c-3",name:"Pak Electric Supply",type:"customer",city:"Rawalpindi",email:"office@pakelectric.example",taxId:"DEMO-3456789",registered:false,creditLimit:"800000",terms:15,customerClass:"Retailer"},
    {id:"c-4",name:"United Traders",type:"customer",city:"Multan",email:"hello@united.example",taxId:"DEMO-4567890",registered:true,creditLimit:"1800000",terms:30,customerClass:"Distributor"},
    {id:"s-1",name:"Shenzhen Bright Technology",type:"supplier",city:"Shenzhen",email:"export@bright.example",taxId:"DEMO-CN-1902",registered:false,creditLimit:"0",terms:60,customerClass:"Importer"},
    {id:"s-2",name:"Guangzhou Home Industries",type:"supplier",city:"Guangzhou",email:"export@home.example",taxId:"DEMO-CN-2104",registered:false,creditLimit:"0",terms:45,customerClass:"Importer"},
    {id:"s-3",name:"Pakistan Packaging Co.",type:"supplier",city:"Karachi",email:"sales@packaging.example",taxId:"DEMO-7654321",registered:true,creditLimit:"0",terms:30,customerClass:"Domestic"}
  ];
  w.items=[
    {id:"i-1",sku:"EL-001",name:"LED Panel Light · 24W",category:"Lighting",hsCode:"9405.1100",unit:"pcs",price:"2400",cost:"1450",weight:"0.65",volume:"0.008",reorderLevel:80},
    {id:"i-2",sku:"EL-002",name:"Smart Extension Board",category:"Electrical",hsCode:"8536.6900",unit:"pcs",price:"3200",cost:"1900",weight:"0.8",volume:"0.004",reorderLevel:60},
    {id:"i-3",sku:"HM-001",name:"Electric Kettle · 1.8L",category:"Home",hsCode:"8516.7100",unit:"pcs",price:"4500",cost:"2750",weight:"1.2",volume:"0.012",reorderLevel:50},
    {id:"i-4",sku:"HM-002",name:"Rechargeable Desk Fan",category:"Home",hsCode:"8414.5100",unit:"pcs",price:"6800",cost:"4200",weight:"1.8",volume:"0.021",reorderLevel:40},
    {id:"i-5",sku:"EL-003",name:"USB-C Fast Charger · 65W",category:"Electrical",hsCode:"8504.4000",unit:"pcs",price:"3800",cost:"2100",weight:"0.18",volume:"0.002",reorderLevel:100},
    {id:"i-6",sku:"EL-004",name:"Motion Sensor Switch",category:"Lighting",hsCode:"8536.5000",unit:"pcs",price:"1850",cost:"950",weight:"0.12",volume:"0.001",reorderLevel:80}
  ];
  w.employees=[
    {id:"e-1",name:"Ahmed Raza",role:"Regional Sales Manager",territory:"South",salary:"150000",allowance:"15000",deduction:"0",attendance:30,active:true},
    {id:"e-2",name:"Sara Malik",role:"Area Sales Manager",territory:"Karachi",parentId:"e-1",salary:"95000",allowance:"12000",deduction:"0",attendance:30,active:true},
    {id:"e-3",name:"Bilal Ahmed",role:"Territory Sales Officer",territory:"Lahore",parentId:"e-1",salary:"75000",allowance:"10000",deduction:"0",attendance:28,active:true},
    {id:"e-4",name:"Hamza Khan",role:"Order Booker",territory:"Karachi",parentId:"e-2",salary:"45000",allowance:"5000",deduction:"0",attendance:30,active:true},
    {id:"e-5",name:"Ayesha Siddiqui",role:"Accountant",territory:"Head office",salary:"85000",allowance:"8000",deduction:"0",attendance:30,active:true}
  ];
  w.plans=[{id:"plan-1",name:"Distribution · recovery linked",effectiveFrom:"2026-01-01",effectiveTo:"2030-12-31",type:"category",rate:"2",categoryRates:{Lighting:"2.5",Electrical:"2",Home:"3"},classRates:{Distributor:"2",Retailer:"2.5"},tiers:[{threshold:"0",rate:"2"},{threshold:"500000",rate:"3"}],target:"0",multiplier:"1"}];
  w.periods=[{month:"2026-08",locked:false},{month:"2026-09",locked:false},{month:"2026-10",locked:false}];
  return w;
}
