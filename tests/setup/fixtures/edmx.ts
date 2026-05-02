/**
 * Minimal EDMX fixture used by metadata-manager tests.
 *
 * Includes EntityType "Contact" with NavigationProperty "City" so that the v4
 * lookup detection logic picks up the FK column "CityId" and refines its
 * lookupCollection via the navigation property pass.
 */
export const SIMPLE_EDMX = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx" Version="4.0">
  <edmx:DataServices>
    <Schema xmlns="http://docs.oasis-open.org/odata/ns/edm" Namespace="BPMSoft">
      <EntityType Name="Contact">
        <Property Name="Id" Type="Edm.Guid" Nullable="false"/>
        <Property Name="Name" Type="Edm.String"/>
        <Property Name="CityId" Type="Edm.Guid"/>
        <NavigationProperty Name="City" Type="BPMSoft.City"/>
      </EntityType>
      <EntityType Name="City">
        <Property Name="Id" Type="Edm.Guid" Nullable="false"/>
        <Property Name="Name" Type="Edm.String"/>
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="Contact" EntityType="BPMSoft.Contact"/>
        <EntitySet Name="City" EntityType="BPMSoft.City"/>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;
